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

test('binds every gcloud input to a pinned pattern and to one cell', () => {
  assert.equal(parseShadowGateArguments(ARGV).cellId, 'production-gce-c28')
  // A filter is a string; anything that could steer one has to be refused before it is built.
  assert.throws(() => parseShadowGateArguments(ARGV.with(1, 'production-gce-c28" OR "x')))
  assert.throws(() => parseShadowGateArguments(ARGV.with(3, 'evil.example.test')))
  assert.throws(() => parseShadowGateArguments(ARGV.with(5, 'Onorca Cloud')))
  assert.throws(() => parseShadowGateArguments(ARGV.with(7, 'orca cloud relay')))
  // Host and cell id must name the same cell, or the serving check reads a neighbour.
  assert.throws(() => parseShadowGateArguments(ARGV.with(3, 'c29.relay.onorca.dev')))
  // A run with nowhere to write its verdict is not a report-only run, it is a silent one.
  assert.throws(
    () => parseShadowGateArguments(ARGV.filter((_, index) => index !== 16 && index !== 17)),
    /--output-file is required/
  )
  // The pace is the rung this roll is evidence for, so it has to be one the wave could run.
  for (const pace of ['', '120000', '30000 OR x']) {
    assert.throws(() => parseShadowGateArguments(ARGV.with(19, pace)), /drain-pace-window-ms/)
  }
  assert.throws(() => parseShadowGateArguments(ARGV.with(21, '-1')), /drain-applied/)
  assert.throws(() => parseShadowGateArguments(ARGV.with(23, 'soon')), /drain-settled-at/)
  // A resumed rollback never drains, so it has no applied pace, settle time, or host count.
  const resumed = parseShadowGateArguments(ARGV.with(21, '').with(23, '').with(25, ''))
  assert.equal(resumed.drainAppliedPaceWindowMs, null)
  assert.equal(resumed.targetHosts, null)
})

test('the window runs from drain start to verify end, with named fallbacks', () => {
  const full = resolveWindow({
    drainStartedAt: '2026-09-20T20:00:00Z',
    applyStartedAt: '2026-09-20T20:15:00Z',
    verifyEndedAt: '2026-09-20T20:30:00Z'
  })
  assert.equal(formatTimestamp(full.startedAt), '2026-09-20T20:00:00Z')
  assert.equal(full.startedFrom, 'drain')
  // A resumed rollback never drains, so the apply stands in for the start.
  assert.equal(resolveWindow({
    applyStartedAt: '2026-09-20T20:15:00Z',
    verifyEndedAt: '2026-09-20T20:30:00Z'
  }).startedFrom, 'apply')
  assert.equal(formatTimestamp(resolveWindow({
    verifyEndedAt: '2026-09-20T20:30:00Z'
  }).startedAt), '2026-09-20T20:00:00Z')
  assert.throws(() => resolveWindow({
    drainStartedAt: '2026-09-20T20:30:00Z',
    verifyEndedAt: '2026-09-20T20:30:00Z'
  }))
  assert.throws(() => resolveWindow({ verifyEndedAt: 'not-a-time' }))
})

test('reads are split into sub-windows no longer than the truncation bound', () => {
  const windows = splitWindow(resolveWindow({
    drainStartedAt: '2026-09-20T20:00:00Z',
    verifyEndedAt: '2026-09-20T20:47:00Z'
  }))
  assert.equal(windows.length, 5)
  for (const window of windows) {
    const minutes = (window.endedAt - window.startedAt) / 60_000
    assert.ok(minutes > 0 && minutes <= SUB_WINDOW_MINUTES, `${minutes} minutes`)
  }
  assert.equal(formatTimestamp(windows.at(-1).endedAt), '2026-09-20T20:47:00Z')
})

test('a sub-window that came back at the entry limit is truncated, never a count', () => {
  const truncated = countByMinute([
    { timestamps: minuteOfTimestamps('2026-09-19T15:34', ENTRY_LIMIT) }
  ])
  assert.equal(truncated.truncated, true)
  const failed = countByMinute([{ failed: true, timestamps: [] }])
  assert.equal(failed.truncated, true)
  const counted = countByMinute([
    { timestamps: minuteOfTimestamps('2026-09-19T15:34', 4722) },
    { timestamps: minuteOfTimestamps('2026-09-19T15:33', 278) }
  ])
  assert.deepEqual(
    {
      peak: counted.peak,
      peakMinute: counted.peakMinute,
      total: counted.total,
      truncated: counted.truncated
    },
    { peak: 4722, peakMinute: '2026-09-19T15:34', total: 5000, truncated: false }
  )
})

test('the cell has to announce its listener and stay up across the whole apply', () => {
  assert.equal(judgeCellServing({
    listeningAt: '2026-09-20T20:18:27Z',
    crashesSinceApply: 0
  }).status, 'pass')
  assert.equal(judgeCellServing({ listeningAt: null }).status, 'would-block')
  // A resumed rollback restarts nothing, so there is no boot to find and silence proves nothing.
  assert.equal(judgeCellServing({ listeningAt: null, expectBoot: false }).status, 'unverified')
  assert.equal(judgeCellServing({
    listeningAt: '2026-09-20T20:18:27Z',
    crashesSinceApply: 1
  }).status, 'would-block')
  assert.equal(judgeCellServing({
    listeningAt: null,
    read: { failed: true }
  }).status, 'unverified')
})

test('pool pressure blocks only when it persists across consecutive samples', () => {
  assert.equal(longestRunAtOrAbove([10, 60, 10, 60, 60, 60, 10], 50), 3)
  const burst = judgePool({
    label: 'production-gce-c27',
    // The single-sample waiters=71 that a literal rule called an outage.
    samples: [
      { databasePoolWaitersMax: 12 },
      { databasePoolWaitersMax: 71 },
      { databasePoolWaitersMax: 9 }
    ]
  })
  assert.equal(burst.status, 'warn')
  assert.equal(burst.consecutiveSamplesOverWaitersThreshold, 1)
  assert.equal(judgePool({
    label: 'production-gce-c28',
    samples: [
      { databasePoolWaitersMax: 148 },
      { databasePoolWaitersMax: 125 },
      { databasePoolWaitersMax: 154 }
    ]
  }).status, 'would-block')
  assert.equal(judgePool({
    label: 'production-gce-c28',
    samples: [{ databasePoolWaitersMax: 2, sqlFailuresDelta: 489 }]
  }).status, 'would-block')
  assert.equal(judgePool({
    label: 'production-gce-c29',
    samples: [{ databasePoolWaitersMax: 3, sqlFailuresDelta: 0, totalConnections: 500 }]
  }).status, 'pass')
  // No samples at all is silence, not health.
  assert.equal(judgePool({ label: 'production-gce-c29', samples: [] }).status, 'unverified')
  assert.equal(judgePool({
    label: 'production-gce-c29',
    samples: [{ databasePoolWaitersMax: 1 }],
    failed: true
  }).status, 'unverified')
  // A truncated sample run has holes, and a hole reads to the run rule as a recovery.
  assert.equal(judgePool({
    label: 'production-gce-c29',
    samples: [{ databasePoolWaitersMax: 1 }],
    truncated: true
  }).status, 'unverified')
  // So is a run read across holes, which may join two separate runs into one.
  assert.equal(judgePool({
    label: 'production-gce-c29',
    samples: Array.from({ length: 3 }, () => ({ databasePoolWaitersMax: 80 })),
    truncated: true
  }).status, 'unverified')
  // But one sample past the failure line is a fact, whatever the read missed.
  assert.equal(judgePool({
    label: 'production-gce-c29',
    samples: [{ databasePoolWaitersMax: 1, sqlFailuresDelta: 201 }],
    truncated: true
  }).status, 'would-block')
})

test('Cloud SQL FATALs warn from the first one and block on a run of them', () => {
  assert.equal(judgeCloudSqlFatal({ count: 0 }).status, 'pass')
  assert.equal(judgeCloudSqlFatal({ count: 1 }).status, 'warn')
  assert.equal(judgeCloudSqlFatal({ count: 21 }).status, 'would-block')
  assert.equal(judgeCloudSqlFatal({ count: 0, truncated: true }).status, 'unverified')
  // A truncated count is a floor: already past the block line, more entries only add to it.
  assert.equal(judgeCloudSqlFatal({ count: 20000, truncated: true }).status, 'would-block')
  assert.equal(judgeCloudSqlFatal({ count: 5, truncated: true }).status, 'unverified')
})
