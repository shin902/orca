import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDriver, parseDriverArguments } from './drive-relay-director-deploy.mjs'
import { IMAGE_REPOSITORY, REPOSITORY, WORKFLOWS } from './relay-director-deploy-plan.mjs'
import { RELAY_WORKFLOW_FILE_PREFIX, relayWorkflowPath } from './relay-repository.mjs'

export const COMMIT = 'a'.repeat(40)
export const OLD = `sha256:${'1'.repeat(64)}`
export const NEW = `sha256:${'2'.repeat(64)}`
export const CELL = `sha256:${'3'.repeat(64)}`
export const START = Date.parse('2026-10-05T04:50:00Z')
export const MEMBERSHIP = {
  existingOnly: ['production-gce-c1'],
  migrationOnly: ['production-gce-c34'],
  general: ['production-gce-c27', 'production-gce-c7']
}
export const CONTROL = {
  generation: 39,
  enabled: true,
  observationStartedAt: 1_786_687_676_179,
  notBefore: 1_790_934_023_000,
  ratePerMinute: 10,
  preferenceMaxAgeMs: 86_400_000,
  hostCooldownMs: 604_800_000,
  drainGraceMs: 3_600_000
}

export function controlLine(mode, control, extra = {}) {
  const result = { event: 'relay_regional_rehome_control', mode, ...extra, control }
  return `operate / control\tUNKNOWN STEP\t2026-10-05T04:51:27Z ${JSON.stringify(result)}`
}

export function monitorFiles(run, now, overrides = {}) {
  const incidentId = `relay-${run.id}-dry-run`
  const at = (offset) => new Date(now - offset).toISOString()
  const state = JSON.stringify({
    schemaVersion: 4,
    incidentId,
    environment: 'production',
    preDrainDryRun: true,
    migrationPolicy: 'strict',
    recoverySourceCellId: null,
    capacityCellId: null,
    durationMinutes: 15,
    intervalMs: 60_000,
    sampleCount: 16,
    frozenAt: null,
    failures: [],
    startedAt: at(16 * 60_000),
    windowStartedAt: at(15 * 60_000),
    lastSampleAt: at(0),
    completedAt: at(0),
    ...overrides
  })
  const manifest = {
    schemaVersion: 1,
    incidentId,
    runId: String(run.id),
    runAttempt: 1,
    commitSha: run.headSha,
    mode: 'dry-run',
    files: { [`${incidentId}.state.json`]: createHash('sha256').update(state).digest('hex') }
  }
  return {
    [`${incidentId}.state.json`]: state,
    'evidence-manifest.json': JSON.stringify(manifest)
  }
}

// A model of GitHub Actions and Cloud Run: each dispatch does what the real workflow would do to
// `world`, including the side effects a failing run leaves behind.
export function fakeWorld(overrides = {}) {
  const world = {
    now: START,
    main: COMMIT,
    nextRunId: 37_000_000_000,
    runs: [],
    active: [],
    printUrl: true,
    revision: 700,
    serving: { revision: 'orca-cloud-relay-00700-qor', digest: OLD, createdAt: START - 86_400_000 },
    rollback: { revision: 'orca-cloud-relay-00699-das', digest: OLD },
    cells: ['production-gce-c1'],
    registry: {},
    selector: { generation: 345, attemptId: 'x', membership: MEMBERSHIP },
    control: CONTROL,
    publishedDigest: NEW,
    pushLogDigest: undefined,
    fail: {},
    monitorState: {},
    director5xx: () => 10,
    prompts: [],
    answer: (question) => question.match(/^Type (\S+(?: [0-9a-f]{12})?) to continue/)[1],
    printed: [],
    ...overrides
  }
  // The last rehome run before this deploy, where the driver finds the current generation.
  world.runs.push({
    id: 1,
    file: WORKFLOWS.rehome.file,
    conclusion: 'success',
    log: controlLine('enable', world.control)
  })
  world.dispatches = () => world.runs.filter((run) => run.dispatched)
  return world
}

export function promote(world, digest) {
  world.revision += 5
  world.rollback = { revision: `orca-cloud-relay-00${world.revision - 1}-rbk`, digest }
  world.serving = {
    revision: `orca-cloud-relay-00${world.revision}-new`,
    digest,
    createdAt: world.now
  }
}

export const nextGeneration = (world, enabled, step = 1) => {
  world.control = { ...world.control, generation: world.control.generation + step, enabled }
}

export function simulate(world, run) {
  const { inputs } = run
  const failure = world.fail[run.key]
  delete world.fail[run.key]
  run.conclusion = failure ? 'failure' : 'success'
  if (failure === 'before-apply') {
    return
  }
  if (run.file === WORKFLOWS.admission.file && inputs.mode === 'inspect') {
    const result = {
      v: 1,
      mode: 'inspect',
      generation: world.selector.generation,
      membership: world.selector.membership
    }
    run.artifacts[`relay-asia-admission-result-${run.id}-1`] = {
      'result.json': JSON.stringify(result)
    }
  } else if (run.file === WORKFLOWS.admission.file) {
    assert.equal(inputs.confirmation, 'CONFIGURE_ASIA_DIRECTOR')
    promote(world, inputs['director-image-digest'])
    world.cells = [...world.cells, ...inputs['cell-ids'].split(',')]
  } else if (run.file === WORKFLOWS.rehome.file) {
    const identities =
      inputs['director-image-digest'] === world.serving.digest &&
      inputs['rollback-image-digest'] === world.rollback.digest
    const matches =
      Number(inputs['expected-control-generation']) === world.control.generation &&
      Number(inputs['expected-selector-generation']) === world.selector.generation
    if (inputs.mode === 'pause' && matches && world.control.enabled) {
      assert.equal(inputs.confirmation, 'PAUSE_REGIONAL_REHOMING')
      // The real job applies the pause before anything else can fail.
      nextGeneration(world, false)
      run.log = controlLine('pause', world.control)
    } else if (inputs.mode === 'enable') {
      assert.equal(inputs.confirmation, 'ENABLE_REGIONAL_REHOMING')
      assert.equal(
        world.runs.find((other) => other.id === Number(inputs['monitor-run-id']))?.file,
        WORKFLOWS.monitor.file
      )
      if (matches && identities && !failure) {
        nextGeneration(world, true)
        run.log = controlLine('enable', world.control)
        return
      }
      run.conclusion = 'failure'
      if (failure === 'applied-silent') {
        // Applied, then a later step failed and the recovery printed nothing.
        nextGeneration(world, true)
        run.log = controlLine('enable', world.control)
        return
      }
      // Applied, then the job's own recovery disabled it again; or a director safety pause got
      // there first and recovery found it disabled.
      if (failure === 'applied-then-recovered') {
        nextGeneration(world, false, 2)
      }
      if (failure === 'safety-pause') {
        nextGeneration(world, false, 3)
      }
      run.log = controlLine('recover-enable', world.control, {
        recovered: failure === 'applied-then-recovered'
      })
    } else if (!matches || (inputs.mode === 'inspect' && !identities)) {
      run.conclusion = 'failure'
    } else {
      run.log = controlLine(inputs.mode, world.control)
    }
  } else if (run.file === WORKFLOWS.publish.file) {
    world.registry[`${IMAGE_REPOSITORY}:sha-${run.headSha}`] = world.publishedDigest
    run.log = `publish\tBuild\tsha-${run.headSha}: digest: ${world.pushLogDigest ?? world.publishedDigest} size: 3241`
  } else if (run.file === WORKFLOWS.director.file) {
    if (
      world.control.enabled ||
      Number(inputs['expected-rehome-generation']) !== world.control.generation
    ) {
      run.conclusion = 'failure'
      return
    }
    promote(world, inputs['image-digest'])
    // Blue/green takes minutes; traffic moves about one before the run completes.
    world.now += 4 * 60_000
  } else if (run.file === WORKFLOWS.monitor.file) {
    world.now += 16 * 60_000
    run.artifacts[`relay-monitor-dry-run-${run.id}-1`] = monitorFiles(
      run,
      world.now,
      world.monitorState
    )
  }
}
