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

test('publishes first, types every phrase, and enables on the digests now serving', async () => {
  const world = fakeWorld()
  assert.equal((await start(world)).done, true)
  assert.deepEqual(keys(world), [
    'publish-relay-production:publish',
    'operate-relay-asia-admission:inspect',
    'operate-relay-production-rehome:inspect',
    'operate-relay-production-rehome:pause',
    'deploy-relay-production-director:deploy',
    'operate-relay-production-rehome:inspect',
    'monitor-relay-production:dry-run',
    'operate-relay-production-rehome:enable'
  ])
  assert.deepEqual(world.prompts, [
    'DEPLOY aaaaaaaaaaaa',
    'PAUSE_REGIONAL_REHOMING',
    'ENABLE_REGIONAL_REHOMING'
  ])
  assert.ok(world.questions.every((question) => question.endsWith('\n')))
  assert.ok(
    world.questions.some((question) =>
      question.includes(
        'arms an automatic enable, sent about 17 min from now and only if the monitor is green and its evidence is at most 150 s old'
      )
    )
  )
  const [deploy] = dispatched(world, DEPLOY)
  assert.deepEqual(
    [
      deploy.inputs['image-digest'],
      deploy.inputs['predecessor-image-digest'],
      deploy.inputs['expected-rehome-generation']
    ],
    [NEW, OLD, '40']
  )
  const [enable] = dispatched(world, REHOME('enable'))
  const [monitor] = dispatched(world, MONITOR)
  assert.deepEqual(
    [
      enable.inputs['director-image-digest'],
      enable.inputs['rollback-image-digest'],
      enable.inputs['expected-control-generation'],
      enable.inputs['monitor-run-id']
    ],
    [NEW, NEW, '40', String(monitor.id)]
  )
  assert.equal(monitor.inputs['expected-general-cells'], 'production-gce-c27,production-gce-c7')
  assert.deepEqual(live(world), [41, true])
})

test('a wrong phrase stops before rehome or the director is touched', async () => {
  const world = fakeWorld({ answer: () => 'yes' })
  assert.match((await stopped(start(world))).message, /expected DEPLOY aaaaaaaaaaaa/)
  assert.deepEqual(keys(world), [
    'publish-relay-production:publish',
    'operate-relay-asia-admission:inspect',
    'operate-relay-production-rehome:inspect'
  ])
})

test('F2: rehome found paused is never adopted; --leave-rehome-paused deploys and leaves it paused', async () => {
  const world = fakeWorld({ control: { ...CONTROL, generation: 52, enabled: false } })
  assert.match(
    (await stopped(start(world))).message,
    /did not pause it.*--pause-run.*--leave-rehome-paused/s
  )
  assert.match(report(world), /drive-relay-director-deploy\.mjs .*--publish-run \d+/)
  await rerun(world).catch(() => {})
  assert.equal(dispatched(world, PUBLISH).length, 1)
  await start(world, ['--leave-rehome-paused'])
  assert.equal(
    dispatched(world, REHOME('pause')).length + dispatched(world, REHOME('enable')).length,
    0
  )
  assert.equal(dispatched(world, DEPLOY)[0].inputs['expected-rehome-generation'], '52')
  assert.deepEqual(live(world), [52, false])
})

test('F2: main moving is caught before any rehome change, and after the pause it changes nothing', async () => {
  const moved = fakeWorld({ main: 'b'.repeat(40) })
  assert.match((await stopped(start(moved))).message, /not the reviewed/)
  assert.equal(moved.dispatches().length, 0)

  const world = fakeWorld()
  const deps = dependencies(world)
  const run = deps.run
  deps.run = (program, args, input) => {
    const result = run(program, args, input)
    if (args[0] === 'workflow' && JSON.parse(input).mode === 'pause') {
      world.main = 'b'.repeat(40)
    }
    return result
  }
  assert.equal((await start(world, [], deps)).done, true)
  assert.deepEqual(live(world), [41, true])
})

test('ops-log 22:59Z: main moving during the inspects and the typed phrase no longer stops the deploy', async () => {
  const world = fakeWorld()
  const deps = dependencies(world)
  const run = deps.run
  deps.run = (program, args, input) => {
    const result = run(program, args, input)
    if (args[0] === 'workflow' && JSON.parse(input).mode === 'inspect') {
      world.main = 'b'.repeat(40)
    }
    return result
  }
  assert.equal((await start(world, [], deps)).done, true)
  assert.equal(dispatched(world, PUBLISH)[0].headSha, COMMIT)
  assert.equal(dispatched(world, DEPLOY)[0].inputs['image-digest'], NEW)
})

test('main moving between the check and the publish stops untouched, naming the reuse command', async () => {
  const world = fakeWorld()
  const deps = dependencies(world)
  const run = deps.run
  deps.run = (program, args, input) => {
    if (args[0] === 'workflow') {
      world.main = 'b'.repeat(40)
    }
    return run(program, args, input)
  }
  assert.match((await stopped(start(world, [], deps))).message, /main moved/)
  const publishRun = String(dispatched(world, PUBLISH)[0].id)
  assert.deepEqual(keys(world), ['publish-relay-production:publish'])
  // The only command printed is the one that reuses the build.
  const commands = world.printed.filter((line) => line.includes('&& node dev/scripts/'))
  assert.equal(commands.length, 1)
  assert.match(commands[0], new RegExp(`--commit ${world.main} --publish-run ${publishRun}$`))
  assert.equal((await rerun(world)).done, true)
  assert.equal(dispatched(world, PUBLISH).length, 1)
  assert.deepEqual(live(world), [41, true])
})

test('a running workflow is summarised, not streamed', async () => {
  const world = fakeWorld({ polls: { [PUBLISH]: 40 } })
  assert.equal((await start(world)).done, true)
  assert.deepEqual(
    world.printed
      .filter((line) => / publish: (in_progress|success)/.test(line))
      .map((line) => line.slice(25)),
    [
      'publish: in_progress, 0 min',
      'publish: in_progress, 5 min',
      `publish: success https://github.com/${REPOSITORY}/actions/runs/${dispatched(world, PUBLISH)[0].id}`
    ]
  )
})

test('a publish whose log disagrees with the registry stops before rehome is touched', async () => {
  const world = fakeWorld({ pushLogDigest: CELL })
  assert.match((await stopped(start(world))).message, /tag moved/)
  assert.equal(dispatched(world, REHOME('pause')).length, 0)
  assert.match(report(world), /rehome: not read; this run did not change it/)
})

test('dry run dispatches nothing and prints every step', async () => {
  const world = fakeWorld()
  const directory = logDirectory()
  await createDriver(
    parseDriverArguments([
      '--commit',
      COMMIT,
      '--dry-run',
      '--configure',
      `production-gce-c34=${CELL}`,
      '--log-directory',
      directory
    ]),
    dependencies(world)
  ).run()
  assert.equal(world.dispatches().length, 0)
  assert.equal(world.prompts.length, 0)
  const plan = world.printed.filter((line) => line.includes(' plan '))
  assert.equal(plan.length, 10)
  assert.ok(plan.some((line) => line.includes('"expected-control-generation":"39"')))
  assert.ok(
    plan.some((line) => line.includes('"confirmation":"<operator types CONFIGURE_ASIA_DIRECTOR>"'))
  )
  assert.deepEqual(
    readdirSync(directory).map((name) => name.endsWith('-dry-run.log')),
    [true]
  )
})

test('an in-flight relay workflow stops the preflight; no printed run URL stops the dispatch', async () => {
  const busy = fakeWorld({
    active: [
      {
        id: 9,
        path: relayWorkflowPath('deploy-relay-production-same-cap.yml'),
        name: 'Same cap',
        status: 'waiting'
      }
    ]
  })
  assert.match((await stopped(start(busy))).message, /in flight/)
  assert.equal(busy.dispatches().length, 0)
  const silent = fakeWorld({ printUrl: false })
  assert.match((await stopped(start(silent))).message, /printed no run URL/)
})
