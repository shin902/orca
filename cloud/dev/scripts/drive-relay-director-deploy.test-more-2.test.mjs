import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  MONITOR_MAX_AGE_AT_ENABLE_MS,
  createDriver,
  parseDriverArguments
} from './drive-relay-director-deploy.mjs'
import {
  IMAGE_REPOSITORY,
  REPOSITORY,
  WORKFLOWS,
  blocksDeploy,
  parseConfigureWave,
  pausedGeneration,
  rehomeResultFromLog,
  validateDispatchInputs
} from './relay-director-deploy-plan.mjs'
import { RELAY_WORKFLOW_FILE_PREFIX, relayWorkflowPath } from './relay-repository.mjs'

import {
  COMMIT,
  OLD,
  NEW,
  CELL,
  START,
  MEMBERSHIP,
  CONTROL,
  controlLine,
  monitorFiles,
  fakeWorld,
  promote,
  nextGeneration,
  simulate,
  flag,
  gh,
  gcloud,
  dependencies,
  logDirectory,
  drive,
  start,
  rerun,
  stopped,
  keys,
  dispatched,
  REHOME,
  DEPLOY,
  PUBLISH,
  MONITOR,
  report,
  live
} from './drive-relay-director-deploy-fixture.mjs'

test('F1: an interrupt while the pause is in flight says rehome is changing, and the printed command finishes', async () => {
  const world = fakeWorld()
  const deps = dependencies(world)
  let driver
  world.onView = () => {
    if (world.dispatches().at(-1)?.inputs.mode === 'pause' && !world.interrupted) {
      world.interrupted = true
      driver.interrupt('SIGINT')
      throw new Error('killed')
    }
  }
  driver = createDriver(
    parseDriverArguments(['--commit', COMMIT, '--log-directory', logDirectory()]),
    deps
  )
  await driver.run().catch(() => {})
  assert.match(
    report(world),
    /STOPPED: interrupted by SIGINT[\s\S]*REHOME IS CHANGING: the pause run .* applies on its own/
  )
  assert.match(report(world), /finish with: cd cloud && .* --publish-run \d+ --pause-run \d+/)
  assert.equal(await rerun(world).then((result) => result.done), true)
  assert.equal(dispatched(world, REHOME('pause')).length, 1)
  assert.equal(dispatched(world, PUBLISH).length, 1)
  assert.deepEqual(live(world), [41, true])
})

test('F1: an interrupt while the enable is in flight never says rehome is paused', async () => {
  const world = fakeWorld()
  const deps = dependencies(world)
  let driver
  world.onView = () => {
    if (world.dispatches().at(-1)?.inputs.mode === 'enable') {
      driver.interrupt('SIGTERM')
    }
  }
  driver = createDriver(
    parseDriverArguments(['--commit', COMMIT, '--log-directory', logDirectory()]),
    deps
  )
  await driver.run()
  const text = report(world)
  assert.match(
    text,
    /REHOME IS CHANGING: the enable run .* it enables rehome, or disables it again if it fails/
  )
  assert.doesNotMatch(text.slice(text.indexOf('interrupted')), /REHOME IS PAUSED/)
})

test('a pause run that printed nothing is PAUSE UNCONFIRMED, and a later safety pause is never lifted', async () => {
  const world = fakeWorld({ fail: { [REHOME('pause')]: 'before-apply' } })
  await stopped(start(world))
  assert.match(report(world), /PAUSE UNCONFIRMED: .* printed no pause. Rehome MAY BE PAUSED/)
  // A director safety pause lands; the operator follows the report's command.
  nextGeneration(world, false)
  assert.match((await stopped(rerun(world))).message, /printed no pause of its own/)
  assert.equal(dispatched(world, REHOME('enable')).length, 0)
})

test('a failed deploy leaves its pause owned, and the printed command finishes without pausing or publishing again', async () => {
  const world = fakeWorld({ fail: { [DEPLOY]: 'before-apply' } })
  await stopped(start(world))
  assert.match(report(world), /REHOME IS PAUSED by this driver at generation 40/)
  assert.match(report(world), /rollback point: orca-cloud-relay-00700-qor/)
  await rerun(world)
  assert.equal(dispatched(world, REHOME('pause')).length, 1)
  assert.equal(dispatched(world, PUBLISH).length, 1)
  assert.equal(dispatched(world, DEPLOY).length, 2)
  assert.deepEqual(live(world), [41, true])
})

test('a frozen monitor stops with its failures; the re-run runs a fresh one', async () => {
  const failures = [
    { source: 'auth', code: 'threshold_equal', signal: 'health', observed: 0, threshold: 1 }
  ]
  const world = fakeWorld({ monitorState: { frozenAt: '2026-10-05T05:30:00Z', failures } })
  assert.match(
    (await stopped(start(world))).message,
    /incomplete or stale[\s\S]*auth threshold_equal health 0 1/
  )
  world.monitorState = {}
  await rerun(world)
  assert.equal(dispatched(world, MONITOR).length, 2)
  assert.equal(dispatched(world, DEPLOY).length, 1)
  assert.deepEqual(live(world), [41, true])
})

test('stale monitor evidence is not spent on an enable', async () => {
  const world = fakeWorld()
  const deps = dependencies(world)
  const prompt = deps.prompt
  deps.prompt = async (question) => {
    const answer = await prompt(question)
    if (answer === 'ENABLE_REGIONAL_REHOMING') {
      const completed = world.now + 16 * 60_000 - MONITOR_MAX_AGE_AT_ENABLE_MS - 1000
      const at = (offset) => new Date(completed - offset).toISOString()
      world.monitorState = {
        completedAt: at(0),
        lastSampleAt: at(0),
        windowStartedAt: at(15 * 60_000),
        startedAt: at(16 * 60_000)
      }
    }
    return answer
  }
  assert.match((await stopped(start(world, [], deps))).message, /past the 150 s budget/)
  assert.equal(dispatched(world, REHOME('enable')).length, 0)
})

test('the ops-log 05:41Z case: an enable that failed before applying is finished by the printed command', async () => {
  const world = fakeWorld({ fail: { [REHOME('enable')]: 'not-applied' } })
  await stopped(start(world))
  assert.match(report(world), /REHOME IS PAUSED by this driver at generation 40/)
  await rerun(world)
  assert.deepEqual(live(world), [41, true])
})

test('an enable whose own recovery paused rehome again hands ownership to that run', async () => {
  const world = fakeWorld({ fail: { [REHOME('enable')]: 'applied-then-recovered' } })
  await stopped(start(world))
  const [enable] = dispatched(world, REHOME('enable'))
  assert.match(
    report(world),
    new RegExp(`REHOME IS PAUSED by this driver at generation 42 \\(.*${enable.id}\\)`)
  )
  await rerun(world)
  assert.deepEqual(live(world), [43, true])
})

test('F3: a director safety pause found by the enable recovery is never adopted or lifted', async () => {
  const world = fakeWorld({ fail: { [REHOME('enable')]: 'safety-pause' } })
  await stopped(start(world))
  assert.match(report(world), /rehome: generation 43 as last read, PAUSED, not by this driver/)
  const stop = report(world).slice(report(world).indexOf('STOPPED'))
  assert.doesNotMatch(stop, /--pause-run/)
  assert.match((await stopped(rerun(world))).message, /did not pause it/)
  const [pause] = dispatched(world, REHOME('pause'))
  const claim = await stopped(
    drive(world, [
      '--commit',
      COMMIT,
      '--publish-run',
      String(dispatched(world, PUBLISH)[0].id),
      '--pause-run',
      String(pause.id)
    ])
  )
  assert.match(claim.message, /not the pause .* made at 40/)
  assert.equal(dispatched(world, REHOME('enable')).length, 1)
  assert.deepEqual(live(world), [43, false])
})

test('P1: a green enable with an unreadable log is ENABLE UNCONFIRMED, and the printed command settles it', async () => {
  const world = fakeWorld({ unreadableLogs: (run) => run.inputs?.mode === 'enable' })
  await stopped(start(world))
  assert.match(
    report(world),
    /ENABLE UNCONFIRMED: .* did not confirm the enable. Rehome may be enabled, or paused/
  )
  world.unreadableLogs = undefined
  assert.equal((await rerun(world, 'If it enabled rehome')).done, true)
  assert.equal(dispatched(world, REHOME('enable')).length, 1)
  assert.deepEqual(live(world), [41, true])
})

test('configure waits out a soak anchored at the traffic switch, then takes a typed phrase', async () => {
  const world = fakeWorld()
  await start(world, ['--configure', `production-gce-c34=${CELL}`])
  const [configure] = dispatched(world, `${WORKFLOWS.admission.file}:configure`)
  assert.deepEqual(
    [
      configure.inputs['cell-ids'],
      configure.inputs['image-digest'],
      configure.inputs['director-image-digest'],
      configure.inputs['selector-generation']
    ],
    ['production-gce-c34', CELL, NEW, '345']
  )
  assert.ok(world.prompts.includes('CONFIGURE_ASIA_DIRECTOR'))
  const [before, after] = world.reads
  assert.equal(after.to - after.from, 5 * 60_000)
  // The deploy ran 4 minutes; traffic moved a minute before it completed.
  assert.equal(after.from, START + 3 * 60_000)
  assert.equal(before.to, START)
  assert.ok(after.readAt >= after.to + 60_000)
})

test('F5: a tripped soak is judged again on fresh traffic by the printed command', async () => {
  const world = fakeWorld({ director5xx: (from) => (from >= START ? 200 : 10) })
  assert.match(
    (await stopped(start(world, ['--configure', `production-gce-c34=${CELL}`]))).message,
    /5xx rose from 10 to 200/
  )
  assert.match(report(world), /REHOME IS PAUSED by this driver at generation 40/)
  world.director5xx = () => 10
  world.now += 30 * 60_000
  const rerunAt = world.now
  await rerun(world)
  assert.equal(dispatched(world, `${WORKFLOWS.admission.file}:configure`).length, 1)
  assert.ok(world.reads.at(-1).from >= rerunAt)
  assert.deepEqual(live(world), [41, true])
})
