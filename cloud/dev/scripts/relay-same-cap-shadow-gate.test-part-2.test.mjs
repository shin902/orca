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
  directorSamples,
  director503s,
  gcloudSeam,
  productionLikeEntries,
  minuteOfTimestamps
} from './relay-same-cap-shadow-gate.test-support.mjs'

test('row-busy 503s are scheduled only up to the drain-return admissions they ride on', () => {
  const drain = drainReturnByMinute([{
    failed: false,
    samples: [{
      timestamp: '2026-10-05T20:01:00Z',
      drainReturnAssignmentsDelta: 10,
      assign503sByCauseDelta: { relay_assignment_row_busy: 8, 'placement-lane': 5 }
    }]
  }], 1000)
  assert.deepEqual(drain.ownRetriesPerMinute, { '2026-10-05T20:00': 8 })
  assert.equal(drain.rowBusyBeyondDrainTotal, 0)
  const split = withoutDrainDeferrals(
    { perMinute: { '2026-10-05T20:00': 13 } },
    drain,
    ['2026-10-05T20:00']
  )
  // The placement-lane refusals stay: only the row-busy ones were scheduled.
  assert.deepEqual(split.series, [5])
})

test('row-busy 503s beyond the drain stay in the non-drain budget and fail it', () => {
  const minutes = Array.from({ length: 10 }, (_, index) => `2026-10-05T20:0${index}`)
  // No drain in the background, and 3 drain-return admissions a minute in the window against 60
  // row-busy refusals: row contention the drain does not explain.
  const samples = minutes.map((minute, index) => ({
    timestamp: new Date(Date.parse(`${minute}:30Z`) + 30_000).toISOString(),
    drainReturnAssignmentsDelta: index < 5 ? 0 : 3,
    assign503sByCauseDelta: { relay_assignment_row_busy: index < 5 ? 0 : 60 }
  }))
  const drain = drainReturnByMinute([{ failed: false, samples }], 1000)
  assert.equal(drain.rowBusyBeyondDrainTotal, 5 * (60 - 3 - 2))
  const perMinute = Object.fromEntries(minutes.map((minute, index) => [minute, index < 5 ? 2 : 60]))
  const background = backgroundOf(withoutDrainDeferrals({ perMinute }, drain, minutes.slice(0, 5)))
  const observed = withoutDrainDeferrals({ perMinute }, drain, minutes.slice(5))
  assert.deepEqual(observed.series, [55, 55, 55, 55, 55])
  assert.equal(judgeNonDrain503Budget({ observed, background }).status, 'would-block')
})

test('scheduled 503s come out of the count, split across the minutes they cover', () => {
  const drain = drainReturnByMinute([{
    failed: false,
    samples: [
      // Counts 20:00:30-20:01:00, so all of it belongs to 20:00.
      { timestamp: '2026-10-05T20:01:00Z', drainReturnDeferralsDelta: 40, drainReturnAssignmentsDelta: 70 },
      // Counts 20:00:50-20:01:20: a third in 20:00, two thirds in 20:01.
      {
        timestamp: '2026-10-05T20:01:20Z',
        drainReturnDeferralsDelta: 30,
        drainReturnAssignmentsDelta: 90,
        drainReturnRetryAfterSecondsMax: 12,
        placementRejectionsByReasonDelta: { 'host-rate-limited': 6, 'wait-timeout': 50 },
        stickyRejectionsByReasonDelta: { 'host-in-flight': 3, 'queue-full': 9 }
      }
    ]
  }], 1000)
  assert.deepEqual(drain.deferralsPerMinute, { '2026-10-05T20:00': 50, '2026-10-05T20:01': 20 })
  // A host's own early retry is scheduled; a lane that timed out or was full is not.
  assert.deepEqual(drain.ownRetriesPerMinute, { '2026-10-05T20:00': 3, '2026-10-05T20:01': 6 })
  assert.equal(drain.assignmentsPeakPerMinute, 100)
  assert.equal(drain.retryAfterSecondsMax, 12)
  const minutes = ['2026-10-05T20:00', '2026-10-05T20:01', '2026-10-05T20:02']
  const split = withoutDrainDeferrals({
    perMinute: { '2026-10-05T20:00': 90, '2026-10-05T20:01': 20, '2026-10-05T20:02': 25 }
  }, drain, minutes)
  // A minute cannot go negative when more was scheduled than was counted.
  assert.deepEqual(split.series, [37, 0, 25])
  assert.equal(split.peak, 37)
  assert.equal(split.peakMinute, '2026-10-05T20:00')
  assert.equal(split.allPeak, 90)
  assert.equal(split.drainDeferralsTotal, 70)
  assert.equal(split.ownRetriesTotal, 9)
  assert.equal(split.unverified, false)
  // A failed count, or a metrics read that failed, hit its limit, or came back short of one
  // instance's samples, leaves the answer unverified: an empty answer is not a calm director.
  assert.equal(drainReturnByMinute([{ failed: true, samples: [] }], 1000).truncated, true)
  assert.equal(drainReturnByMinute([{ samples: [], minSamples: 20 }], 1000).truncated, true)
  assert.equal(drainReturnByMinute([{
    samples: Array.from({ length: 19 }, (_, index) => ({
      timestamp: new Date(Date.parse('2026-10-05T20:00:30Z') + index * 30_000).toISOString()
    })),
    minSamples: 20
  }], 1000).truncated, true)
  assert.equal(withoutDrainDeferrals({ perMinute: {}, failed: true }, drain, minutes).unverified, true)
  assert.equal(withoutDrainDeferrals(
    { perMinute: {} },
    { deferralsPerMinute: {}, truncated: true },
    minutes
  ).unverified, true)
})

test('the background is the median pre-drain minute, so one incident minute cannot move it', () => {
  const background = backgroundOf({
    minutes: Array.from({ length: 10 }, (_, index) => `2026-10-05T19:5${index}`),
    series: [2, 0, 1, 3, 900, 1, 0, 2, 4, 1],
    peak: 900,
    unverified: false
  })
  assert.equal(background.medianPerMinute, 1.5)
  assert.equal(backgroundOf({ minutes: [], series: [], peak: 0, unverified: false }).unverified, true)
})

test('the rung budget needs two straight minutes over its line, never one', () => {
  const judge = (series, medianPerMinute = 1.5, unverified = false) => judgeNonDrain503Budget({
    observed: { series, peak: Math.max(...series), unverified },
    background: { medianPerMinute, unverified: false }
  })
  const calm = judge([0, 3, 87, 1, 0, 39, 0, 22, 12])
  assert.equal(calm.peakPerMinute, 87)
  // 10-02 c16 and c21: single minutes at 87 and 39 are transients.
  assert.equal(calm.status, 'pass')
  assert.equal(calm.warnAbove, 21.5)
  assert.equal(calm.blockAbove, 41.5)
  assert.equal(judge([0, 25, 23, 0]).status, 'warn')
  // 10-01 c29: thousands a minute for nine minutes.
  assert.equal(judge([288, 2619, 4226, 5357, 6256, 6662]).status, 'would-block')
  assert.equal(judge([0, 42, 42, 0]).status, 'would-block')
  // One minute past max(10x, 200) blocks alone: a short herd is over before a second minute.
  const spike = judge([0, 201, 0])
  assert.equal(spike.spikeAbove, 200)
  assert.equal(spike.status, 'would-block')
  assert.equal(judge([0, 112, 0]).status, 'pass')
  // 10-01 00:30 c28: a brownout already under way lifts the median, and the sustained rule holds.
  assert.equal(judge([8136, 7000, 3000], 824).status, 'would-block')
  // A busy background lifts both lines by its multiple, not just the margin.
  const busy = judge([100, 100], 60)
  assert.equal(busy.warnAbove, 90)
  assert.equal(busy.blockAbove, 120)
  assert.equal(busy.status, 'warn')
  assert.equal(judge([0], 1.5, true).status, 'unverified')
})

test('a drain is judged on how long it tells hosts to wait, not on how many it defers', () => {
  const drain = (retryAfterSecondsMax, truncated = false) => ({
    deferralsTotal: 400,
    deferralsPeakPerMinute: 300,
    assignmentsTotal: 530,
    assignmentsPeakPerMinute: 260,
    retryAfterSecondsMax,
    truncated
  })
  assert.equal(judgeDrainDeferrals(drain(30)).status, 'pass')
  assert.equal(judgeDrainDeferrals(drain(31)).status, 'warn')
  assert.equal(judgeDrainDeferrals(drain(61)).status, 'would-block')
  assert.equal(judgeDrainDeferrals(drain(2, true)).status, 'unverified')
  assert.equal(judgeDrainDeferrals(drain(2)).replacementsPeakPerMinute, 260)
})

// A 30 s rung on a 530-host cell: hundreds of scheduled deferrals in two minutes, over a pre-drain
// background whose own 503s were ordinary. Counting the deferrals as failures would block every
// fast drain.

test('a fast drain\'s deferrals do not read as a brownout', async () => {
  const entries = [
    ...productionLikeEntries(),
    ...director503s('2026-09-20T19:52', 20),
    ...director503s('2026-09-20T19:55', 25),
    ...director503s('2026-09-20T20:00', 400),
    ...director503s('2026-09-20T20:01', 330),
    ...director503s('2026-09-20T20:05', 30),
    ...directorSamples({
      from: '2026-09-20T20:00:30Z',
      count: 4,
      payload: {
        drainReturnDeferralsDelta: 190,
        drainReturnAssignmentsDelta: 130,
        drainReturnRetryAfterSecondsMax: 14
      }
    })
  ]
  const seam = gcloudSeam(entries)
  const report = await evaluateShadowGate(
    parseShadowGateArguments(ARGV.with(19, '30000').with(21, '30000')),
    seam
  )
  // One count of every minute from ten before the drain to the end of the window, whole minutes.
  assert.equal(seam.monitoringCalls.length, 1)
  assert.equal(seam.monitoringCalls[0].query.get('interval.startTime'), '2026-09-20T19:50:00.000Z')
  assert.equal(seam.monitoringCalls[0].query.get('interval.endTime'), '2026-09-20T20:30:00.000Z')
  assert.match(seam.monitoringCalls[0].query.get('filter'), /run\.googleapis\.com\/request_count/)
  assert.match(seam.monitoringCalls[0].query.get('filter'), /"response_code"="503"/)
  assert.equal(seam.monitoringCalls[0].init.headers.authorization, 'Bearer token')
  assert.equal(report.background.minutes, 10)
  assert.equal(Math.max(...report.background.perMinute), 25)
  assert.equal(report.checks.nonDrain503Budget.allPeakPerMinute, 400)
  assert.equal(report.checks.nonDrain503Budget.drainDeferralsTotal, 760)
  assert.equal(report.checks.nonDrain503Budget.peakPerMinute, 30)
  assert.equal(report.checks.nonDrain503Budget.status, 'pass')
  assert.equal(report.checks.drainDeferrals.status, 'pass')
  assert.equal(report.checks.drainDeferrals.replacementsTotal, 520)
  assert.equal(report.drain.paceWindowMs, 30_000)
  assert.equal(report.paceVerdict, 'PASS')
  assert.equal(report.verdict, 'PASS')
  // The same 503s with no deferrals behind them are exactly what the gate exists to catch.
  const brownout = await evaluateShadowGate(
    parseShadowGateArguments(ARGV),
    gcloudSeam(entries.filter((entry) => !entry.payload?.drainReturnDeferralsDelta))
  )
  assert.equal(brownout.checks.nonDrain503Budget.status, 'would-block')
  assert.equal(brownout.paceVerdict, 'WOULD_BLOCK')
})

// The pace verdict is what a canary seals, so fleet noise the pace cannot cause must not reach it.

test('the pace verdict reads only the checks a drain pace can move', async () => {
  const report = await evaluateShadowGate(parseShadowGateArguments(ARGV), gcloudSeam([
    ...productionLikeEntries(),
    { matches: ['FATAL'], timestamp: '2026-09-20T20:10:00Z' }
  ]))
  assert.equal(report.checks.cloudSqlFatal.status, 'warn')
  assert.equal(report.verdict, 'WARN')
  assert.equal(report.paceVerdict, 'PASS')
  assert.deepEqual(PACE_CHECKS, ['nonDrain503Budget', 'drainDeferrals'])
})

// Reproduced in final review: every read succeeds and returns nothing. That must not read as a calm
// drain, or it seals a canary PASS that authorizes a fast batch.

test('a gate whose reads all come back empty is unverified, never a pace PASS', async () => {
  const seam = {
    retryDelayMs: 0,
    fetch: async () => ({ ok: true, json: async () => ({}) }),
    runGcloud: async (args) => ({ stdout: args[0] === 'auth' ? 'token\n' : '[]' })
  }
  const report = await evaluateShadowGate(parseShadowGateArguments(ARGV), seam)
  assert.equal(report.checks.nonDrain503Budget.status, 'unverified')
  assert.equal(report.checks.drainDeferrals.status, 'unverified')
  assert.equal(report.paceVerdict, 'WARN')
})
