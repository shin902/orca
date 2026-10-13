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
  director503s,
  minuteOfTimestamps
} from './relay-same-cap-shadow-gate.test-support.mjs'
import { STAMP_STEPS, C28_INSTANCE, stepBody, metricSamples, productionLikeEntries, gcloudSeam, directorSamples } from './relay-same-cap-shadow-gate.test-support.mjs'

test('a runtime-metrics read at its limit is unverified, not a calm cell', async () => {
  const seam = gcloudSeam([
    ...productionLikeEntries(),
    // 600 samples packed into the first sub-window, past the 500-entry read limit.
    ...metricSamples({
      cellId: 'production-gce-c28',
      from: '2026-09-20T20:00:00Z',
      count: 600,
      intervalMs: 500,
      payload: { databasePoolWaitersMax: 1 }
    })
  ])
  const report = await evaluateShadowGate(parseShadowGateArguments(ARGV), seam)
  assert.equal(report.checks.cellPool.status, 'unverified')
  assert.equal(report.checks.cellPool.truncated, true)
  // The neighbours were read normally, so only the truncated cell is unverified.
  assert.equal(report.checks['fleetPool:production-gce-c27'].status, 'pass')
  assert.equal(report.verdict, 'WARN')
})

test('a resume, which restarts nothing, does not read a missing boot as a failure', async () => {
  const resumed = ARGV.with(9, '').with(11, '').with(13, '')
  const seam = gcloudSeam(productionLikeEntries().filter(
    (entry) => !entry.matches[0].startsWith('listening')
  ))
  const report = await evaluateShadowGate(parseShadowGateArguments(resumed), seam)
  assert.equal(report.window.startedFrom, 'fallback')
  assert.equal(report.checks.cellServing.status, 'unverified')
  assert.equal(report.verdict, 'WARN')
})

test('a gcloud read that never completes is unverified, not a crashed gate', async () => {
  const report = await evaluateShadowGate(parseShadowGateArguments(ARGV), {
    retryDelayMs: 0,
    runGcloud: async () => { throw new Error('PERMISSION_DENIED') }
  })
  assert.equal(report.verdict, 'WARN')
  assert.equal(report.checks.nonDrain503Budget.status, 'unverified')
  assert.equal(report.checks.cellServing.status, 'unverified')
})

// continue-on-error bounds the job's outcome but not its clock; an unbounded read could spend the
// rollout's remaining minutes before the job's own timeout noticed.

test('every read is given a bounded timeout, and a timed-out read is just a failed read', async () => {
  const seam = gcloudSeam()
  await evaluateShadowGate(parseShadowGateArguments(ARGV), seam)
  assert.ok(seam.calls.length > 0)
  for (const { options } of seam.calls) {
    assert.equal(options.timeoutMs, SHADOW_GATE_THRESHOLDS.readTimeoutMs)
    assert.ok(options.timeoutMs > 0 && options.timeoutMs <= 120_000)
  }
  const timedOut = await evaluateShadowGate(parseShadowGateArguments(ARGV), {
    retryDelayMs: 0,
    runGcloud: async () => { throw Object.assign(new Error('ETIMEDOUT'), { killed: true }) }
  })
  assert.equal(timedOut.checks.nonDrain503Budget.status, 'unverified')
  assert.equal(timedOut.verdict, 'WARN')
})

// The reads are serialised, so the cost of a failure that makes every one of them spend its full
// retry budget scales with the window. The deadline is what turns that into a verdict rather than
// a cancelled job, which would take every later cell in the wave with it.

test('the gate stops reading at its own deadline and still reports a verdict', async () => {
  const seam = gcloudSeam()
  // A clock where every read costs its whole retry budget, which is the case the deadline exists
  // for: an expired credential or a Logging 429 storm answers nothing, slowly, every time.
  let elapsedMs = 0
  const report = await evaluateShadowGate(parseShadowGateArguments(ARGV), {
    ...seam,
    now: () => {
      elapsedMs += SHADOW_GATE_THRESHOLDS.readTimeoutMs * READ_ATTEMPTS
      return elapsedMs
    }
  })
  // Everything past the deadline is skipped rather than attempted, so the gate cannot outlive it.
  assert.ok(seam.calls.length > 0, 'the gate must still attempt reads inside its budget')
  assert.ok(
    seam.calls.length * SHADOW_GATE_THRESHOLDS.readTimeoutMs * READ_ATTEMPTS <=
      SHADOW_GATE_THRESHOLDS.overallDeadlineMs,
    'the gate read past its own deadline'
  )
  // A verdict, not a crash: a skipped read is an unverified check, which can never read as PASS.
  assert.equal(report.reportOnly, true)
  assert.equal(report.verdict, 'WARN')
  assert.equal(report.checks.cellServing.status, 'unverified')
  // No read is ever given more time than the budget still has left.
  for (const { options } of seam.calls) {
    assert.ok(options.timeoutMs > 0)
    assert.ok(options.timeoutMs <= SHADOW_GATE_THRESHOLDS.readTimeoutMs)
  }
})

test('the job runs the gate report-only, after verification, and uploads its artifact', () => {
  const workflow = readRelayWorkflow('deploy-relay-production-same-cap-job.yml')
  const gate = workflow.slice(workflow.indexOf('- name: Shadow health gate (report only)'))
  assert.notEqual(gate, '')
  // Two independent guarantees that no verdict can fail a cell: the step's own exit code and this.
  assert.match(gate.slice(0, gate.indexOf('run:')), /continue-on-error: true/)
  assert.match(gate, /relay-same-cap-shadow-gate\.mjs/)
  // The gate and its upload must be bounded in time as well as in outcome: a step that runs past
  // the job's timeout-minutes gets the job cancelled, and cancellation stops the whole wave.
  const gateHeader = gate.slice(0, gate.indexOf('run:'))
  assert.match(gateHeader, /timeout-minutes: (\d+)/)
  const stepTimeoutMinutes = Number(/timeout-minutes: (\d+)/.exec(gateHeader)[1])
  assert.equal(stepTimeoutMinutes, 8)
  // The script has to settle on its own before the runner kills it, or the artifact is never
  // written and the step reports nothing at all.
  assert.ok(
    SHADOW_GATE_THRESHOLDS.overallDeadlineMs < stepTimeoutMinutes * 60_000,
    'the gate deadline must leave the step time to write its verdict'
  )
  const upload = workflow.slice(workflow.indexOf('- name: Publish the shadow health gate verdict'))
  assert.match(upload.slice(0, upload.indexOf('uses:')), /timeout-minutes: 2/)
  assert.match(
    workflow,
    /name: relay-same-cap-shadow-gate-\$\{\{ inputs\.target-cell-id \}\}-\$\{\{ github\.run_id \}\}\.json/
  )
  // The gate is judged over the wave it just ran, so the job has to stamp its own steps, and the
  // stamps reach the script through the environment rather than being expanded into its shell.
  for (const [step, output] of [
    ['drain', 'drain-started-at'],
    ['drain', 'drain-settled-at'],
    ['apply', 'apply-started-at'],
    ['apply', 'apply-completed-at'],
    ['verify-target', 'verify-ended-at']
  ]) {
    // Scoped to the step that owns the stamp: a stamp written anywhere else in the job would
    // still satisfy a whole-file match while recording the wrong instant.
    assert.match(
      stepBody(workflow, STAMP_STEPS[step]),
      new RegExp(`${output}=\\$\\(date -u \\+%FT%TZ\\)`),
      `${output} must be stamped inside the ${step} step`
    )
    assert.match(gate, new RegExp(`\\$\\{\\{ steps\\.${step}\\.outputs\\.${output} \\}\\}`))
    assert.match(gate, new RegExp(`--${output} "\\$\\{[A-Z_]+\\}"`))
  }
  // Settled means restart-safe was proven, so the stamp follows that wait, not the drain call.
  const drainStep = stepBody(workflow, STAMP_STEPS.drain)
  assert.notEqual(drainStep.indexOf('--activity restart-safe'), -1)
  assert.ok(
    drainStep.indexOf('drain-settled-at=') > drainStep.indexOf('--activity restart-safe'),
    'drain-settled-at must be stamped after the restart-safe wait'
  )
  assert.match(drainStep, /drain-applied-pace-window-ms=\$\(jq -er '\.paceWindowMs' <<< "\$\{DRAIN_RESULT\}"\)/)
  for (const flag of ['drain-pace-window-ms', 'drain-applied-pace-window-ms', 'target-hosts']) {
    assert.match(gate, new RegExp(`--${flag} "\\$\\{[A-Z_]+(:-)?\\}"`), flag)
  }
  // The apply-start stamp has to precede the operation that can restart the instance, or the
  // listener it bounds the search by has already happened. Presence is asserted before order,
  // because indexOf answers -1 for an absent stamp and -1 precedes everything.
  const applyStep = stepBody(workflow, STAMP_STEPS.apply)
  const stampedAt = applyStep.indexOf('apply-started-at=')
  const appliedAt = applyStep.indexOf('terraform -chdir=infra/terraform apply')
  assert.notEqual(stampedAt, -1, 'the apply step does not stamp apply-started-at at all')
  assert.notEqual(appliedAt, -1, 'the apply step no longer runs terraform apply')
  assert.ok(stampedAt < appliedAt, 'apply-started-at must be stamped before terraform apply')
  // Verification has to have happened first, or the gate judges a cell nothing checked, and the
  // restore too, so reading logs never holds the cell out of admission for longer than today.
  for (const earlier of [
    '- name: Verify new incarnation, exact image, protocol, and durable safety',
    '- name: Restore only the verified selected cell to its entry admission'
  ]) {
    assert.ok(
      workflow.indexOf(earlier) < workflow.indexOf('- name: Shadow health gate (report only)'),
      earlier
    )
  }
})



