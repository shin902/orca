import assert from 'node:assert/strict'

import { test } from 'node:test'

import { readRelayWorkflow } from './relay-repository.mjs'

import {
  READ_ATTEMPTS,
  evaluateShadowGate,
  parseShadowGateArguments
} from './relay-same-cap-shadow-gate.mjs'

import {
  ENTRY_LIMIT,
  FLEET_POOL_CELL_IDS,
  PACE_CHECKS,
  SHADOW_GATE_THRESHOLDS,
  SUB_WINDOW_MINUTES,
  backgroundOf,
  combineVerdict,
  countByMinute,
  drainReturnByMinute,
  formatTimestamp,
  judgeCellServing,
  judgeCloudSqlFatal,
  judgeDrainDeferrals,
  judgeNonDrain503Budget,
  judgePool,
  longestRunAtOrAbove,
  renderStepSummary,
  resolveWindow,
  splitWindow,
  withoutDrainDeferrals
} from './relay-same-cap-shadow-gate-verdict.mjs'



export const ARGV = [
  '--cell-id', 'production-gce-c28',
  '--cell-host', 'c28.relay.onorca.dev',
  '--project-id', 'onorca-cloud',
  '--director-service', 'orca-cloud-relay',
  '--drain-started-at', '2026-09-20T20:00:00Z',
  '--apply-started-at', '2026-09-20T20:15:00Z',
  '--apply-completed-at', '2026-09-20T20:19:30Z',
  '--verify-ended-at', '2026-09-20T20:30:00Z',
  '--output-file', '/tmp/shadow.json',
  '--drain-pace-window-ms', '300000',
  '--drain-applied-pace-window-ms', '300000',
  '--drain-settled-at', '2026-09-20T20:11:00Z',
  '--target-hosts', '857'
]

export function director503s(minute, count) {
  return [{ minute503: minute, count }]
}

export function minuteOfTimestamps(minute, count) {
  return Array.from(
    { length: count },
    (_, index) => `${minute}:${String(index % 60).padStart(2, '0')}Z`
  )
}


export const STAMP_STEPS = {
  drain: '- name: Reversibly isolate and drain only the selected cell',
  apply: '- name: Apply only the selected same-cap template and MIG',
  'verify-target': '- name: Verify new incarnation, exact image, protocol, and durable safety'
}

// One step's own lines: from its marker to the next sibling step at the same indent.
export function stepBody(workflow, marker) {
  const start = workflow.indexOf(marker)
  assert.notEqual(start, -1, `the job no longer has a step named ${marker}`)
  const next = workflow.indexOf('\n      - ', start + marker.length)
  return workflow.slice(start, next === -1 ? undefined : next)
}

export const C28_INSTANCE = '5031087219978409220'

// Runtime-metrics samples at the 30 s cadence production emits them at, unless a case needs
// enough of them inside one sub-window to reach the read's limit.
export function metricSamples({ cellId, from, count, payload = {}, intervalMs = 30_000 }) {
  return Array.from({ length: count }, (_, index) => ({
    matches: ['orca_relay_runtime_metrics', `jsonPayload.cellId="${cellId}"`],
    timestamp: new Date(Date.parse(from) + index * intervalMs).toISOString(),
    payload: {
      totalConnections: 857,
      databasePoolWaitersMax: 4,
      databasePoolWaiting: 1,
      sqlFailuresDelta: 0,
      reconnectsDelta: 0,
      ...payload
    }
  }))
}

// The exact entry shapes production returned for c28 on 2026-09-20: the crash at 20:18:10Z and
// the listener at 20:18:27Z, both on instance 5031087219978409220.
export function productionLikeEntries() {
  return [
    {
      matches: ['listening on https://c28.relay.onorca.dev'],
      timestamp: '2026-09-20T20:18:27.470301969Z',
      instanceId: C28_INSTANCE
    },
    ...metricSamples({ cellId: 'production-gce-c28', from: '2026-09-20T20:20:00Z', count: 20 }),
    ...metricSamples({ cellId: 'production-gce-c27', from: '2026-09-20T20:20:00Z', count: 20 }),
    ...metricSamples({ cellId: 'production-gce-c29', from: '2026-09-20T20:20:00Z', count: 20 }),
    ...metricSamples({ cellId: 'production-gce-c30', from: '2026-09-20T20:20:00Z', count: 20 }),
    ...metricSamples({ cellId: 'production-gce-c31', from: '2026-09-20T20:20:00Z', count: 20 }),
    ...metricSamples({ cellId: 'production-gce-c34', from: '2026-09-20T20:20:00Z', count: 20 }),
    // One director instance's samples from ten minutes before the drain to the window's end.
    ...directorSamples({ from: '2026-09-20T19:50:00Z', count: 80, payload: {} })
  ]
}

/**
 * A gcloud seam that honours the filter it is given: its timestamp bounds, its instance-id scope,
 * the `--limit`, and the newest-first order. A fake that ignored the bounds would let a
 * wrongly-bounded query pass, which is exactly the bug class these tests exist to catch.
 */
export function gcloudSeam(entries = productionLikeEntries()) {
  const calls = []
  const monitoringCalls = []
  return {
    calls,
    monitoringCalls,
    retryDelayMs: 0,
    // Cloud Monitoring's request counter, aligned per minute: one point per minute that had any,
    // stamped at the end of the minute it counts, inside the requested interval only.
    fetch: async (url, init) => {
      const query = new URL(url).searchParams
      monitoringCalls.push({ query, init })
      const startedAt = Date.parse(query.get('interval.startTime'))
      const endedAt = Date.parse(query.get('interval.endTime'))
      const points = entries
        .filter((entry) => entry.minute503 !== undefined)
        .map((entry) => ({ endedAt: Date.parse(`${entry.minute503}:00Z`) + 60_000, count: entry.count }))
        .filter((point) => point.endedAt > startedAt && point.endedAt <= endedAt)
        .map((point) => ({
          interval: { endTime: new Date(point.endedAt).toISOString() },
          value: { int64Value: String(point.count) }
        }))
      return { ok: true, json: async () => ({ timeSeries: points.length ? [{ points }] : [] }) }
    },
    runGcloud: async (args, options) => {
      if (args[0] === 'auth') {return { stdout: 'token\n' }}
      const filter = args[2]
      const limit = Number(args[args.indexOf('--limit') + 1])
      calls.push({ filter, limit, options })
      const startedAt = Date.parse(/timestamp>="([^"]+)"/.exec(filter)[1])
      const endedAt = Date.parse(/timestamp<"([^"]+)"/.exec(filter)[1])
      const instanceId = /resource\.labels\.instance_id="([^"]+)"/.exec(filter)?.[1]
      const matched = entries.filter((entry) => {
        if (entry.minute503 !== undefined) {return false}
        const at = Date.parse(entry.timestamp)
        if (at < startedAt || at >= endedAt) {return false}
        if (instanceId && entry.instanceId !== instanceId) {return false}
        return entry.matches.every((needle) => filter.includes(needle))
      })
      matched.sort((left, right) => Date.parse(right.timestamp) - Date.parse(left.timestamp))
      return {
        stdout: JSON.stringify(matched.slice(0, limit).map((entry) => ({
          timestamp: entry.timestamp,
          ...(entry.instanceId ? { resource: { labels: { instance_id: entry.instanceId } } } : {}),
          ...(entry.payload ? { jsonPayload: entry.payload } : {})
        })))
      }
    }
  }
}



// Director runtime-metrics samples: one per 30 s per instance, each counting the 30 s before it.
export function directorSamples({ from, count, payload }) {
  return Array.from({ length: count }, (_, index) => ({
    matches: ['orca_relay_runtime_metrics', 'resource.type="cloud_run_revision"'],
    timestamp: new Date(Date.parse(from) + index * 30_000).toISOString(),
    payload
  }))
}

