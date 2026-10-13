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

test("G5: the driver's own run, still listed as in progress, does not block its next step", async () => {
  const world = fakeWorld()
  const deps = dependencies(world)
  const run = deps.run
  deps.run = (program, args, input) => {
    const result = run(program, args, input)
    if (args[0] === 'workflow' && JSON.parse(input).mode === 'dry-run') {
      const monitor = world.runs.at(-1)
      world.active.push({
        id: monitor.id,
        path: relayWorkflowPath('monitor-relay-production.yml'),
        name: 'Monitor',
        status: 'in_progress'
      })
    }
    return result
  }
  assert.equal((await start(world, [], deps)).done, true)
  assert.deepEqual(live(world), [41, true])
})

test('argument parsing and plan helpers fail closed', () => {
  assert.throws(() => parseDriverArguments([]), /missing --commit/)
  assert.throws(() => parseDriverArguments(['--commit', 'abc']), /full commit SHA/)
  assert.throws(
    () => parseDriverArguments(['--commit', COMMIT, '--pause-run', 'x']),
    /must be a run ID/
  )
  assert.throws(
    () => parseDriverArguments(['--commit', COMMIT, '--pause-run', '5', '--leave-rehome-paused']),
    /contradict/
  )
  assert.throws(
    () => parseDriverArguments(['--commit', COMMIT, '--configure', 'production-gce-c34']),
    /--configure must be/
  )
  assert.deepEqual(parseConfigureWave(`production-gce-c27,production-gce-c28=${CELL}`).cells, [
    'production-gce-c27',
    'production-gce-c28'
  ])
  assert.throws(
    () => validateDispatchInputs({ confirmation: '<operator types X>' }),
    /not resolved/
  )
  assert.throws(
    () => validateDispatchInputs({ 'image-digest': 'sha256:abc' }),
    /not a sha256 digest/
  )
  assert.ok(blocksDeploy(relayWorkflowPath('push-deploy.yml')))
  assert.ok(blocksDeploy(`${relayWorkflowPath('push-deploy.yml')}@refs/heads/main`))
  assert.ok(!blocksDeploy(relayWorkflowPath('monitor-relay-clock-skew.yml')))
  const disabled = { ...CONTROL, enabled: false }
  assert.equal(pausedGeneration(rehomeResultFromLog(controlLine('pause', disabled))), 39)
  assert.equal(
    pausedGeneration(
      rehomeResultFromLog(controlLine('recover-enable', disabled, { recovered: true }))
    ),
    39
  )
  assert.equal(
    pausedGeneration(
      rehomeResultFromLog(controlLine('recover-enable', disabled, { recovered: false }))
    ),
    undefined
  )
  assert.equal(pausedGeneration(rehomeResultFromLog(controlLine('inspect', disabled))), undefined)
  assert.throws(() => rehomeResultFromLog('nothing'), /printed no control/)
})
