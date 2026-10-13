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


import {
  ARGV,
  minuteOfTimestamps
} from './relay-same-cap-shadow-gate.test-support.mjs'
import { STAMP_STEPS, C28_INSTANCE, stepBody, metricSamples, productionLikeEntries, gcloudSeam, directorSamples } from './relay-same-cap-shadow-gate.test-support.mjs'

test('the verdict is the worst check, and an unverified read never reads as PASS', () => {
  assert.equal(combineVerdict({ a: { status: 'pass' }, b: { status: 'pass' } }), 'PASS')
  assert.equal(combineVerdict({ a: { status: 'pass' }, b: { status: 'warn' } }), 'WARN')
  assert.equal(combineVerdict({ a: { status: 'pass' }, b: { status: 'unverified' } }), 'WARN')
  assert.equal(
    combineVerdict({ a: { status: 'would-block' }, b: { status: 'unverified' } }),
    'WOULD_BLOCK'
  )
})

// The step that owns each stamp, so a stamp's presence is judged where it has to be written.
test('reads every promoted asia-east2 cell as fleet pool, C34 included', () => {
  assert.deepEqual(FLEET_POOL_CELL_IDS, [
    'production-gce-c27', 'production-gce-c28', 'production-gce-c29', 'production-gce-c30',
    'production-gce-c31', 'production-gce-c34'
  ])
})

test('a healthy roll reads as PASS and names the instance it proved serving', async () => {
  const seam = gcloudSeam()
  const report = await evaluateShadowGate(parseShadowGateArguments(ARGV), seam)
  assert.equal(report.verdict, 'PASS')
  assert.equal(report.reportOnly, true)
  assert.equal(report.cellInstanceId, C28_INSTANCE)
  assert.equal(report.window.startedFrom, 'drain')
  assert.equal(report.window.applyCompletedAt, '2026-09-20T20:19:30Z')
  assert.deepEqual(Object.keys(report.checks).sort(), [
    'cellPool',
    'cellServing',
    'cloudSqlFatal',
    'drainDeferrals',
    'fleetPool:production-gce-c27',
    'fleetPool:production-gce-c29',
    'fleetPool:production-gce-c30',
    'fleetPool:production-gce-c31',
    'fleetPool:production-gce-c34',
    'nonDrain503Budget'
  ])
  assert.deepEqual(report.drain, {
    paceWindowMs: 300_000,
    appliedPaceWindowMs: 300_000,
    targetHosts: 857,
    settledAt: '2026-09-20T20:11:00Z',
    settledAfterSeconds: 660
  })
  // Every read carries explicit bounds: --freshness does not bind on these logs.
  for (const { filter } of seam.calls) {
    assert.match(filter, /timestamp>="[^"]+" AND timestamp<"[^"]+"/)
  }
  // Cell text lives in jsonPayload.message; a textPayload filter matches nothing and says so.
  assert.equal(seam.calls.some(({ filter }) => filter.includes('textPayload')), false)
  assert.match(renderStepSummary(report), /Shadow health gate \(report only\): PASS/)
  assert.match(renderStepSummary(report), /Drain pace 300000 ms \(cell applied: 300000\), 857 hosts/)
})

// The listener lands while the MIG is still converging, so a boot search opening at the apply's
// completion finds nothing and calls a healthy roll a failure.

test('the boot search opens at the apply start, not at its completion', async () => {
  const seam = gcloudSeam()
  const report = await evaluateShadowGate(parseShadowGateArguments(ARGV), seam)
  assert.equal(report.checks.cellServing.status, 'pass')
  assert.equal(report.checks.cellServing.listeningAt, '2026-09-20T20:18:27.470301969Z')
  const listenerRead = seam.calls.find(({ filter }) => filter.includes('listening on https://'))
  assert.match(listenerRead.filter, /timestamp>="2026-09-20T20:15:00Z"/)
  // The listener at 20:18:27 sits after the apply start and before its completion at 20:19:30,
  // so a completion-bounded search would have missed it entirely.
  assert.ok(Date.parse('2026-09-20T20:18:27.470301969Z') < Date.parse('2026-09-20T20:19:30Z'))
})

// A crash-restart loop ends with a listener announcement that looks like a clean boot. Counting
// crashes only after the last announcement erases the loop that produced it.

test('a crash before the final listener still counts against the roll', async () => {
  const seam = gcloudSeam([
    ...productionLikeEntries(),
    {
      matches: ['throw er'],
      timestamp: '2026-09-20T20:18:10.651702662Z',
      instanceId: C28_INSTANCE
    }
  ])
  const report = await evaluateShadowGate(parseShadowGateArguments(ARGV), seam)
  assert.equal(report.checks.cellServing.crashesSinceApply, 1)
  assert.equal(report.checks.cellServing.status, 'would-block')
  assert.equal(report.verdict, 'WOULD_BLOCK')
  const crashRead = seam.calls.find(({ filter }) => filter.includes('throw er'))
  // Bounded at the apply start, and still scoped to the instance the listener identified.
  assert.match(crashRead.filter, /timestamp>="2026-09-20T20:15:00Z"/)
  assert.match(crashRead.filter, new RegExp(`resource\\.labels\\.instance_id="${C28_INSTANCE}"`))
})

test('a crash on a neighbouring instance is not charged to this cell', async () => {
  const seam = gcloudSeam([
    ...productionLikeEntries(),
    { matches: ['throw er'], timestamp: '2026-09-20T20:18:10Z', instanceId: '9999999999999999999' }
  ])
  const report = await evaluateShadowGate(parseShadowGateArguments(ARGV), seam)
  assert.equal(report.checks.cellServing.crashesSinceApply, 0)
  assert.equal(report.checks.cellServing.status, 'pass')
})

// A sample run returned at the read's limit has holes, and the consecutive-sample rule reads a
// hole as a recovery, so it must not be judged as though it were complete.
