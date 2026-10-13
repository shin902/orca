// Operator-local driver for a production relay director deploy. It only dispatches the existing
// audited workflows and reads their results back; every safety check stays in those workflows.
//
// It keeps no state between runs. Every decision comes from live state read at the start: the
// serving director, its configured cells, and the rehome control. The one fact live state cannot
// show, that a pause is this driver's own, is the run that made it (`--pause-run`), checked
// against that run's log and the live generation. On any stop it prints the command that
// finishes the deploy from wherever it got to.
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { parseDriverArguments } from './drive-relay-director-deploy-arguments.mjs'
import {
  countDirector5xx,
  monitorDirectorSoak,
  SOAK_MS
} from './drive-relay-director-deploy-soak.mjs'
import { createStopReport } from './drive-relay-director-deploy-stop-report.mjs'
import { createTypedConfirmation } from './drive-relay-director-deploy-confirmation.mjs'
import { createDriverPreflight } from './drive-relay-director-deploy-preflight.mjs'
import {
  buildWorkflowCommand,
  createRerunCommand
} from './drive-relay-director-deploy-commands.mjs'
import {
  createWorkflowDispatcher,
  createWorkflowLaneMonitor
} from './drive-relay-director-deploy-dispatch.mjs'
import {
  describeDirectorState,
  readDirectorState
} from './drive-relay-director-deploy-director-state.mjs'
import {
  monitorWorkflowEvidence,
  createWorkflowEvidenceReader,
  createWorkflowRunWatcher
} from './drive-relay-director-deploy-run-monitor.mjs'
import {
  DIRECTOR_SERVICE,
  IMAGE_REPOSITORY,
  PROJECT,
  REPOSITORY,
  WORKFLOW_REF,
  WORKFLOWS,
  admissionInspectInputs,
  admissionInspectResult,
  blocksDeploy,
  configureInputs,
  directorDeployInputs,
  logConfirmsPublishedDigest,
  monitorDryRunInputs,
  pausedGeneration,
  publishInputs,
  rehomeEnableInputs,
  rehomeInspectInputs,
  rehomePauseInputs,
  rehomeResultFromLog,
  requireDigest,
  validateDispatchInputs
} from './relay-director-deploy-plan.mjs'

const ACTIVE_RUN_STATUSES = ['queued', 'in_progress', 'waiting', 'requested', 'pending']
// The enable job verifies the monitor within 5 minutes of completion after ~2.5 minutes of setup.
export const MONITOR_MAX_AGE_AT_ENABLE_MS = 150_000
const REHOME_HISTORY_RUNS = 5

export class DriverStop extends Error {}
export { parseDriverArguments, SOAK_MS }

const timestamp = (ms) => new Date(ms).toISOString()
const runUrl = (runId) => `https://github.com/${REPOSITORY}/actions/runs/${runId}`
const words = (text) => text.split(' ')

export function createDriver(config, deps) {
  let logPath
  const typedPhrases = new Map()
  // Everything learned this run; nothing outlives the process.
  const known = { director: undefined, selector: undefined, control: undefined }
  let rollbackPoint
  let published = config.publishRun ? { runId: config.publishRun } : undefined
  let owned // { generation, runId }: the pause this driver made, the only rehome state it owns
  // A pause or enable this run cannot vouch for: `changing` while it may still apply on its own,
  // `unconfirmed` once it finished without a usable result. { kind, name, runId?, url? }
  let uncertain
  let movedBuild // { commit, runId }: a publish that built a newer main than the reviewed commit
  let login
  const ownRunIds = new Set()
  let enabled = false

  function log(message) {
    const line = `${timestamp(deps.now())} ${message}`
    deps.print(line)
    if (logPath) {
      appendFileSync(logPath, `${line}\n`)
    }
  }

  function command(program, args, input) {
    const result = deps.run(program, args, input)
    if (result.status !== 0) {
      const detail = String(result.stderr ?? '')
        .trim()
        .split('\n')
        .slice(-3)
        .join(' | ')
      throw new Error(`${program} ${args.slice(0, 4).join(' ')} failed: ${detail}`)
    }
    return String(result.stdout ?? '')
  }

  const gh = (args, input) => command('gh', args, input)
  const ghJson = (args) => JSON.parse(gh(args))
  const gcloudJson = (args) =>
    JSON.parse(command('gcloud', [...args, '--project', PROJECT, '--format=json']))

  const readDirector = () => readDirectorState(gcloudJson, words)
  const describeDirector = describeDirectorState

  const { activeRuns, requireQuietLane } = createWorkflowLaneMonitor({
    activeStatuses: ACTIVE_RUN_STATUSES,
    repository: REPOSITORY,
    gh,
    words,
    blocksDeploy,
    ownRunIds,
    runUrl,
    DriverStop
  })

  const { viewRun, waitForRun } = createWorkflowRunWatcher({
    repository: REPOSITORY,
    ghJson,
    words,
    log,
    now: deps.now,
    sleep: deps.sleep
  })

  const { dispatch, requireSuccess } = createWorkflowDispatcher({
    repository: REPOSITORY,
    workflowRef: WORKFLOW_REF,
    gh,
    words,
    validateDispatchInputs,
    view,
    requireQuietLane,
    log,
    getUncertain: () => uncertain,
    setUncertain: (value) => {
      uncertain = value
    },
    ownRunIds,
    runUrl,
    viewRun,
    waitForRun,
    DriverStop
  })

  const { runLog, rehomeResult, withArtifact } = createWorkflowEvidenceReader({
    repository: REPOSITORY,
    gh,
    words,
    runUrl,
    sleep: deps.sleep,
    createTemp: () => mkdtempSync(join(tmpdir(), 'relay-director-deploy-')),
    removeTemp: (directory) => rmSync(directory, { recursive: true, force: true }),
    rehomeResultFromLog
  })

  const typed = createTypedConfirmation({
    typedPhrases,
    prompt: deps.prompt,
    log,
    DriverStop
  })

  // The digest the publish run pushed: the registry's digest for the commit's tag, which the push
  // line in the run's own log must name too.
  async function publishedDigest(runId) {
    const view = viewRun(runId)
    if (view.workflowName !== WORKFLOWS.publish.name || view.conclusion !== 'success') {
      throw new DriverStop(`${runUrl(runId)} is not a successful ${WORKFLOWS.publish.file} run`)
    }
    if (view.headSha !== config.commit) {
      movedBuild = { commit: view.headSha, runId }
      throw new DriverStop(
        `publish ${runUrl(runId)} built ${view.headSha}, not the reviewed ${config.commit}: main moved`
      )
    }
    const tag = `${IMAGE_REPOSITORY}:sha-${config.commit}`
    const digest = command(
      'gcloud',
      words(
        `artifacts docker images describe ${tag} --project ${PROJECT} --format=value(image_summary.digest)`
      )
    ).trim()
    requireDigest(digest, 'registry digest of the published tag')
    if (!logConfirmsPublishedDigest(await runLog(runId), config.commit, digest)) {
      throw new DriverStop(
        `registry digest ${digest} is not the digest ${runUrl(runId)} pushed; the tag moved`
      )
    }
    return digest
  }

  async function lastKnownRehomeGeneration() {
    const runs = ghJson(
      words(
        `run list -R ${REPOSITORY} --workflow ${WORKFLOWS.rehome.file} --status completed --limit ${REHOME_HISTORY_RUNS} --json databaseId`
      )
    )
    for (const run of runs) {
      const result = await rehomeResult(run.databaseId)
      if (result) {
        log(
          `rehome generation candidate ${result.control.generation} from ${runUrl(run.databaseId)}`
        )
        return result.control.generation
      }
    }
    throw new DriverStop(
      'no recent rehome run printed the control generation; pass --rehome-generation'
    )
  }

  // Values every input builder reads. A dry run shows what is not known yet as `<placeholder>`,
  // which validateDispatchInputs refuses, so a placeholder can never be dispatched.
  function view() {
    const unknown = (label) => `<${label}>`
    const placeholder = (label) => new Proxy({}, { get: () => unknown(label) })
    const fromAdmission = [unknown('from admission inspect')]
    const control = known.control
    return {
      director: known.director,
      selector: known.selector ?? {
        generation: fromAdmission[0],
        membership: new Proxy({}, { get: () => fromAdmission })
      },
      control: control ?? placeholder('inspected'),
      pausedGeneration:
        owned?.generation ??
        (control?.enabled === false
          ? control.generation
          : unknown('rehome generation after pause')),
      published: published?.digest ?? unknown('published digest'),
      rollbackDigest: rollbackPoint?.digest ?? known.director?.servingDigest,
      monitor: placeholder('monitor run'),
      afterDeploy: placeholder('digest read from gcloud after the deploy'),
      notBefore: config.dryRun ? unknown('now, epoch ms') : Math.floor(deps.now() / 1000) * 1000,
      confirmation: (phrase) =>
        typedPhrases.has(phrase) ? phrase : unknown(`operator types ${phrase}`)
    }
  }

  const deployPending = () => known.director.servingDigest !== published?.digest
  const pendingWaves = () =>
    config.configure.filter((wave) => wave.cells.some((cell) => !known.director.cells.has(cell)))
  const work = () => deployPending() || pendingWaves().length > 0

  const count5xx = (fromMs, toMs) =>
    countDirector5xx({
      fromMs,
      toMs,
      service: DIRECTOR_SERVICE,
      project: PROJECT,
      command,
      timestamp
    })

  const soak = (deployedAt) =>
    monitorDirectorSoak({
      deployedAt,
      createdAt: known.director.servingCreatedAt,
      now: deps.now,
      sleep: deps.sleep,
      count5xx,
      log,
      timestamp
    }).catch((error) => {
      throw new DriverStop(error.message)
    })

  const monitorCompletedAt = (run) =>
    monitorWorkflowEvidence(run, {
      readArtifact: withArtifact,
      now: deps.now,
      log,
      DriverStop
    })

  const preflight = createDriverPreflight({
    config,
    log,
    activeRuns,
    requireQuietLane,
    ghJson,
    words,
    repository: REPOSITORY,
    workflows: WORKFLOWS,
    getLogin: () => login,
    gh,
    workflowRef: WORKFLOW_REF,
    getPublished: () => published,
    getOwned: () => owned,
    runUrl,
    rehomeResult,
    pausedGeneration,
    publishedDigest,
    publishStep: () => publishStep.run(publishStep),
    known,
    readDirector,
    setRollbackPoint: (value) => {
      rollbackPoint = value
    },
    describeDirector,
    lastKnownRehomeGeneration,
    readSteps,
    dispatch,
    requireSuccess,
    withArtifact,
    admissionInspectResult,
    readFileSync,
    join,
    DriverStop,
    setOwned: (value) => {
      owned = value
    },
    setEnabled: (value) => {
      enabled = value
    }
  })

  // The two read-only inspects every real run starts with; never resumed, always run fresh.
  function readSteps(generation) {
    return [
      {
        name: 'preflight-admission',
        workflow: WORKFLOWS.admission,
        inputs: (v) => admissionInspectInputs(v.director.servingDigest)
      },
      {
        name: 'preflight-rehome',
        workflow: WORKFLOWS.rehome,
        inputs: (v) => rehomeInspectInputs({ ...v, controlGeneration: generation })
      }
    ]
  }

  const publishStep = {
    name: 'publish',
    workflow: WORKFLOWS.publish,
    inputs: publishInputs,
    when: () => !published,
    run: async (step) => {
      const run = await dispatch(step)
      requireSuccess(run)
      published = { runId: run.runId }
      published.digest = await publishedDigest(run.runId)
      log(`published ${IMAGE_REPOSITORY}@${published.digest}`)
    }
  }

  // The one ordered plan. `when` reads live state, so a re-run skips what is already done; a dry run
  // prints every step whose need it cannot know yet.
  function plan() {
    let deployedAt
    let verified
    let monitor
    return [
      publishStep,
      {
        name: 'pause',
        workflow: WORKFLOWS.rehome,
        changesRehome: true,
        inputs: (v) =>
          rehomePauseInputs({ ...v, confirmation: v.confirmation('PAUSE_REGIONAL_REHOMING') }),
        when: () => known.control?.enabled === true && !owned && work(),
        run: async (step) => {
          await typed('PAUSE_REGIONAL_REHOMING')
          const run = await dispatch(step)
          const result = await rehomeResult(run.runId)
          const generation = result && pausedGeneration(result)
          if (generation !== known.control.generation + 1) {
            uncertain.kind = 'unconfirmed'
            throw new DriverStop(
              `${run.url} (${run.conclusion}) printed no pause at generation ${known.control.generation + 1}`
            )
          }
          owned = { generation, runId: run.runId }
          uncertain = undefined
          log(
            `REHOME PAUSED at generation ${generation}. To finish from here after any stop: ${rerunCommand()}`
          )
        }
      },
      {
        name: 'deploy',
        workflow: WORKFLOWS.director,
        inputs: (v) =>
          directorDeployInputs({
            imageDigest: v.published,
            predecessorDigest: v.rollbackDigest,
            rehomeGeneration: v.pausedGeneration
          }),
        when: () => !published || deployPending(),
        run: async (step) => {
          requireSuccess(await dispatch(step))
          deployedAt = deps.now()
          known.director = readDirector()
          if (deployPending()) {
            throw new DriverStop(
              `deploy: ${describeDirector(known.director)}, not ${published.digest}`
            )
          }
        }
      },
      ...config.configure.slice(0, 1).map(() => ({
        name: 'soak',
        description: `wait ${SOAK_MS / 60_000} min, then compare director 5xx`,
        // A wave already configured means an earlier run passed the soak on this image.
        when: () => pendingWaves().length === config.configure.length,
        run: () => soak(deployedAt)
      })),
      ...config.configure.map((wave) => ({
        name: `configure:${wave.cells.join(',')}`,
        workflow: WORKFLOWS.admission,
        inputs: (v) =>
          configureInputs({
            ...wave,
            directorDigest: v.published,
            selectorGeneration: v.selector.generation,
            confirmation: v.confirmation('CONFIGURE_ASIA_DIRECTOR')
          }),
        when: () => pendingWaves().includes(wave),
        run: async (step) => {
          await typed('CONFIGURE_ASIA_DIRECTOR')
          requireSuccess(await dispatch(step))
          known.director = readDirector()
          if (deployPending()) {
            throw new DriverStop(
              `${step.name}: ${describeDirector(known.director)}, not ${published.digest}`
            )
          }
        }
      })),
      // Inspect binds the exact serving and rollback digests, so a wrong one fails here, read-only,
      // before 15 minutes of monitor evidence is spent on it.
      {
        name: 'verify-identities',
        workflow: WORKFLOWS.rehome,
        inputs: (v) =>
          rehomeInspectInputs({
            director: verified ?? v.afterDeploy,
            selector: v.selector,
            controlGeneration: v.pausedGeneration
          }),
        when: () => Boolean(owned),
        run: async (step) => {
          verified = readDirector()
          const run = await dispatch(step)
          const control = (await rehomeResult(run.runId))?.control
          if (
            run.conclusion !== 'success' ||
            control?.enabled !== false ||
            control.generation !== owned.generation
          ) {
            throw new DriverStop(
              `verify-identities ${run.url} (${run.conclusion}) did not find rehome paused at ${owned.generation} with ${describeDirector(verified)}`
            )
          }
        }
      },
      {
        name: 'monitor',
        workflow: WORKFLOWS.monitor,
        inputs: (v) => monitorDryRunInputs(v.selector),
        when: () => Boolean(owned),
        run: async (step) => {
          // The operator arms the enable before the 15-minute watch; it still dispatches only on green.
          await typed(
            'ENABLE_REGIONAL_REHOMING',
            ` (this arms an automatic enable, sent about 17 min from now and only if the monitor is green and its evidence is at most ${MONITOR_MAX_AGE_AT_ENABLE_MS / 1000} s old)`
          )
          const run = await dispatch(step)
          requireSuccess(run)
          monitor = {
            runId: run.runId,
            attempt: run.attempt,
            completedAt: await monitorCompletedAt(run)
          }
        }
      },
      {
        name: 'enable',
        workflow: WORKFLOWS.rehome,
        changesRehome: true,
        inputs: (v) =>
          rehomeEnableInputs({
            ...v,
            director: verified ?? v.afterDeploy,
            controlGeneration: v.pausedGeneration,
            monitor: monitor ?? v.monitor,
            confirmation: v.confirmation('ENABLE_REGIONAL_REHOMING')
          }),
        when: () => Boolean(owned),
        run: async (step) => {
          const ageMs = deps.now() - Date.parse(monitor.completedAt)
          if (ageMs > MONITOR_MAX_AGE_AT_ENABLE_MS) {
            throw new DriverStop(
              `monitor evidence is ${Math.round(ageMs / 1000)} s old, past the ${MONITOR_MAX_AGE_AT_ENABLE_MS / 1000} s budget; re-run for a fresh monitor`
            )
          }
          const now = readDirector()
          if (
            now.servingDigest !== verified.servingDigest ||
            now.rollbackDigest !== verified.rollbackDigest
          ) {
            throw new DriverStop(
              `the director changed after its digests were verified: ${describeDirector(now)}`
            )
          }
          if (known.control.ratePerMinute !== 10) {
            log(
              `enable starts at the job's fixed 10 hosts/min (was ${known.control.ratePerMinute})`
            )
          }
          const run = await dispatch(step)
          const result = await rehomeResult(run.runId)
          if (result) {
            known.control = result.control
          }
          // A failed run is never an enable, whatever it printed last.
          if (
            run.conclusion === 'success' &&
            result?.mode === 'enable' &&
            result.control.enabled &&
            result.control.generation === owned.generation + 1
          ) {
            owned = undefined
            uncertain = undefined
            enabled = true
            log(`REHOME RE-ENABLED at generation ${result.control.generation}`)
            return
          }
          if (result?.mode !== 'recover-enable') {
            uncertain.kind = 'unconfirmed'
            throw new DriverStop(`${run.url} (${run.conclusion}) printed no enable result`)
          }
          // Recovery that disabled rehome itself is this driver's pause too. Recovery that found it
          // already disabled at another generation found someone else's pause, such as a director
          // safety pause: this driver gives up ownership and will never lift it.
          uncertain = undefined
          const recovered = pausedGeneration(result)
          if (recovered !== undefined) {
            owned = { generation: recovered, runId: run.runId }
          } else if (result.control.generation !== owned.generation) {
            owned = undefined
          }
          throw new DriverStop(
            `enable ${run.url} failed; the job's recovery left rehome paused at generation ${result.control.generation}`
          )
        }
      }
    ]
  }

  const rerunCommand = createRerunCommand({
    config,
    getOwned: () => owned,
    getPublished: () => published
  })

  const stopReport = (reason) =>
    createStopReport({
      reason,
      repository: REPOSITORY,
      workflows: WORKFLOWS,
      uncertain,
      known,
      owned,
      enabled,
      published,
      rollbackPoint,
      movedBuild,
      config,
      runUrl,
      rerunCommand,
      describeDirector,
      readDirector,
      ghCommand,
      directorDeployInputs
    })

  const ghCommand = (workflow, inputs) =>
    buildWorkflowCommand(workflow, inputs, { repository: REPOSITORY, workflowRef: WORKFLOW_REF })

  async function run() {
    const stamp = timestamp(deps.now()).replace(/[:.]/g, '-')
    mkdirSync(config.logDirectory, { recursive: true, mode: 0o700 })
    logPath = join(
      config.logDirectory,
      `${stamp}-${config.commit.slice(0, 12)}${config.dryRun ? '-dry-run' : ''}.log`
    )
    log(`${config.dryRun ? 'dry run' : 'start'}: ${rerunCommand()}`)
    try {
      login = gh(['api', 'user', '--jq', '.login']).trim()
      const generation = await preflight()
      const steps = plan()
      for (const step of [...(config.dryRun ? readSteps(generation) : []), ...steps]) {
        const needed = config.dryRun || step.when() ? '' : ' (done or not needed)'
        const detail = step.workflow
          ? `${step.workflow.file} ${JSON.stringify(step.inputs({ ...view(), control: { ...view().control, generation } }))}`
          : step.description
        log(`plan ${step.name}${needed}: ${detail}`)
      }
      if (config.dryRun) {
        log('dry run: nothing dispatched')
        return { dryRun: true }
      }
      if (steps.some((step) => step.when())) {
        await typed(`DEPLOY ${config.commit.slice(0, 12)}`)
      }
      for (const step of steps) {
        if (step.when()) {
          await step.run(step)
        }
      }
      const rehome =
        enabled || known.control.enabled ? 'enabled' : 'left paused (--leave-rehome-paused)'
      log(
        `DONE: ${describeDirector(known.director)}; rehome ${rehome}${rollbackPoint ? `; rollback point ${rollbackPoint.revision} ${rollbackPoint.digest}` : ''}`
      )
      return { done: true, logPath }
    } catch (error) {
      for (const line of stopReport(error.message).split('\n')) {
        log(line)
      }
      throw Object.assign(error instanceof DriverStop ? error : new DriverStop(error.message), {
        reported: true,
        logPath
      })
    }
  }

  // Ctrl-C, SIGTERM or a closed terminal still leaves the operator the live state and the re-run.
  function interrupt(signal) {
    if (logPath) {
      for (const line of stopReport(`interrupted by ${signal}`).split('\n')) {
        log(line)
      }
    }
  }

  return { run, interrupt }
}
