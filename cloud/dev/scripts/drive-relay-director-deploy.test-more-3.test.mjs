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

test('P8 and G1: the printed command never reports DONE without reading rehome', async () => {
  const world = fakeWorld()
  await start(world)
  const before = world.dispatches().length
  world.prompts.length = 0
  const publishRun = String(dispatched(world, PUBLISH)[0].id)
  assert.equal((await drive(world, ['--commit', COMMIT, '--publish-run', publishRun])).done, true)
  assert.deepEqual(keys(world).slice(before), [
    'operate-relay-asia-admission:inspect',
    'operate-relay-production-rehome:inspect'
  ])
  assert.equal(world.prompts.length, 0)
  assert.match(report(world), /DONE: .* rehome enabled/)

  // G1: the deploy is done but the driver's pause still holds; dropping --pause-run must not hide it.
  const paused = fakeWorld({ monitorState: { frozenAt: '2026-10-05T05:30:00Z' } })
  await stopped(start(paused))
  const run = String(dispatched(paused, PUBLISH)[0].id)
  assert.match(
    (await stopped(drive(paused, ['--commit', COMMIT, '--publish-run', run]))).message,
    /did not pause it/
  )
  assert.deepEqual(live(paused), [40, false])
})

test("G2: --pause-run accepts only this operator's own rehome-control run", async () => {
  const world = fakeWorld({ control: { ...CONTROL, generation: 40, enabled: false } })
  // Another operator paused rehome by hand.
  world.runs.push({
    id: 900,
    file: WORKFLOWS.rehome.file,
    actor: 'someone-else',
    conclusion: 'success',
    log: controlLine('pause', world.control)
  })
  assert.match(
    (await stopped(start(world, ['--pause-run', '900']))).message,
    /is not a .* run by operator/
  )
  // A run of another workflow cannot prove a pause either.
  world.runs.push({
    id: 901,
    file: WORKFLOWS.monitor.file,
    conclusion: 'success',
    log: controlLine('pause', world.control)
  })
  assert.match(
    (await stopped(start(world, ['--pause-run', '901']))).message,
    /is not a .* run by operator/
  )
  assert.equal(world.dispatches().length, 0)
  assert.deepEqual(live(world), [40, false])
})

test('G3: a failed enable run is never reported RE-ENABLED, whatever it printed last', async () => {
  const world = fakeWorld({ fail: { [REHOME('enable')]: 'applied-silent' } })
  await stopped(start(world))
  assert.doesNotMatch(report(world), /RE-ENABLED|DONE/)
  assert.match(report(world), /ENABLE UNCONFIRMED: .* did not confirm the enable/)
  // The printed command re-reads live state: rehome is at the pause's generation + 1, enabled.
  const pauseRun = String(dispatched(world, REHOME('pause'))[0].id)
  const publishRun = String(dispatched(world, PUBLISH)[0].id)
  assert.equal(
    (await drive(world, ['--commit', COMMIT, '--publish-run', publishRun, '--pause-run', pauseRun]))
      .done,
    true
  )
  assert.equal(dispatched(world, REHOME('enable')).length, 1)
})

test('Q1 and C1: after a hard kill mid-pause, the re-run names the pause its log recorded and finishes with it', async () => {
  const world = fakeWorld()
  const deps = dependencies(world)
  const directory = logDirectory()
  let logAtKill
  world.onView = () => {
    if (world.dispatches().at(-1)?.key !== REHOME('pause')) {
      return
    }
    // SIGKILL writes no stop report: only what was logged before the watch survives.
    logAtKill = readFileSync(join(directory, readdirSync(directory)[0]), 'utf8')
    world.onView = undefined
    throw new Error('SIGKILL')
  }
  await stopped(
    createDriver(
      parseDriverArguments(['--commit', COMMIT, '--log-directory', directory]),
      deps
    ).run()
  )
  world.printed.length = 0
  const [pause] = dispatched(world, REHOME('pause'))
  assert.match(logAtKill, new RegExp(`runs/${pause.id}`))
  const publishRun = String(dispatched(world, PUBLISH)[0].id)
  assert.match(
    (await stopped(drive(world, ['--commit', COMMIT, '--publish-run', publishRun]))).message,
    /did not pause it.*--pause-run its log printed/
  )
  assert.deepEqual(live(world), [40, false])
  const argv = ['--commit', COMMIT, '--publish-run', publishRun, '--pause-run', String(pause.id)]
  assert.equal((await drive(world, argv)).done, true)
  assert.deepEqual(live(world), [41, true])
})

test('Q5: a failed enable followed by an unexplained disable is never adopted', async () => {
  const world = fakeWorld()
  const deps = dependencies(world)
  const run = deps.run
  deps.run = (program, args, input) => {
    const result = run(program, args, input)
    if (args[0] === 'workflow' && JSON.parse(input).mode === 'enable') {
      world.runs.at(-1).conclusion = 'failure'
      world.control = { ...world.control, generation: 42, enabled: false }
    }
    return result
  }
  await stopped(start(world, [], deps))
  assert.match(report(world), /ENABLE UNCONFIRMED/)
  assert.doesNotMatch(report(world), /RE-ENABLED|DONE/)
  const commands = ['failed before applying', 'paused rehome again'].map((marker) => {
    const line = world.printed.findLast((printed) => printed.includes(marker))
    return line.slice(line.indexOf('.mjs ') + 5).split(' ')
  })
  for (const argv of commands) {
    assert.match((await stopped(drive(world, argv))).message, /--rehome-generation|cannot prove/)
    const pinned = await stopped(drive(world, [...argv, '--rehome-generation', '42']))
    assert.match(pinned.message, /not the pause|cannot prove/)
  }
  assert.equal(dispatched(world, REHOME('enable')).length, 1)
  assert.deepEqual(live(world), [42, false])
})

test('C1: a pause whose run cannot be viewed, or printed no URL, is reported as REHOME IS CHANGING', async () => {
  const world = fakeWorld()
  const deps = dependencies(world)
  const run = deps.run
  deps.run = (program, args, input) => {
    const pause = dispatched(world, REHOME('pause'))[0]
    if (pause && args[1] === 'view' && args[2] === String(pause.id) && args.includes('--json')) {
      return { status: 1, stdout: '', stderr: 'HTTP 502' }
    }
    return run(program, args, input)
  }
  await stopped(start(world, [], deps))
  const [pause] = dispatched(world, REHOME('pause'))
  assert.match(report(world), new RegExp(`REHOME IS CHANGING: the pause run .*${pause.id}`))
  assert.match(report(world), new RegExp(`finish with: cd cloud && .*--pause-run ${pause.id}`))
  assert.doesNotMatch(report(world), /Re-run to finish/)

  const silent = fakeWorld()
  const silentDeps = dependencies(silent)
  const silentRun = silentDeps.run
  silentDeps.run = (program, args, input) => {
    const result = silentRun(program, args, input)
    return args[0] === 'workflow' && JSON.parse(input).mode === 'pause'
      ? { ...result, stdout: 'Created\n' }
      : result
  }
  await stopped(start(silent, [], silentDeps))
  assert.match(
    report(silent),
    /REHOME IS CHANGING: the pause run \(gh printed no URL; find it at https:/
  )
  assert.doesNotMatch(report(silent), /Re-run to finish/)
})

test('C2: --leave-rehome-paused refuses an enabled switch instead of pausing it', async () => {
  const world = fakeWorld()
  assert.match(
    (await stopped(start(world, ['--leave-rehome-paused']))).message,
    /accepts only a paused switch/
  )
  assert.equal(dispatched(world, REHOME('pause')).length, 0)
})

test('G4: an interrupt during the enable prints both commands that can finish', async () => {
  const world = fakeWorld()
  const deps = dependencies(world)
  let driver
  world.onView = () => {
    if (world.dispatches().at(-1)?.inputs.mode === 'enable') {
      driver.interrupt('SIGINT')
    }
  }
  driver = createDriver(
    parseDriverArguments(['--commit', COMMIT, '--log-directory', logDirectory()]),
    deps
  )
  await driver.run()
  const [pause] = dispatched(world, REHOME('pause'))
  const [enable] = dispatched(world, REHOME('enable'))
  assert.match(
    report(world),
    new RegExp(
      `If it enabled rehome, or failed before applying, finish with: cd cloud && .*--pause-run ${pause.id}`
    )
  )
  assert.match(
    report(world),
    new RegExp(
      `If its recovery paused rehome again, finish with: cd cloud && .*--pause-run ${enable.id}`
    )
  )
})
