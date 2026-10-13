import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RELAY_WORKFLOW_FILE_PREFIX, relayWorkflowPath } from './relay-repository.mjs'
import { createDriver, parseDriverArguments } from './drive-relay-director-deploy.mjs'
import { IMAGE_REPOSITORY, REPOSITORY, WORKFLOWS } from './relay-director-deploy-plan.mjs'
import {
  COMMIT,
  CONTROL,
  MEMBERSHIP,
  OLD,
  START,
  controlLine,
  fakeWorld,
  monitorFiles,
  nextGeneration,
  promote,
  simulate
} from './drive-relay-director-deploy-world.mjs'
export {
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
  simulate
} from './drive-relay-director-deploy-world.mjs'

export function flag(args, name) {
  const index = args.indexOf(name)
  return index === -1 ? undefined : args[index + 1]
}

export function gh(world, args, input) {
  const ok = (value) => ({
    status: 0,
    stdout: typeof value === 'string' ? value : JSON.stringify(value),
    stderr: ''
  })
  if (args[0] === 'api' && args[1] === 'user') {
    return ok('operator\n')
  }
  if (args[0] === 'api' && args.includes('--paginate')) {
    const status = flag(args, '-f').slice('status='.length)
    return ok(
      world.active
        .filter((run) => run.status === status)
        .map((run) => `${JSON.stringify(run)}\n`)
        .join('')
    )
  }
  if (args[0] === 'api' && args[1].includes('/actions/runs/')) {
    const claimed = world.runs.find(
      (candidate) => candidate.id === Number(args[1].split('/').at(-1))
    )
    return ok({
      path: relayWorkflowPath(claimed.file.slice(RELAY_WORKFLOW_FILE_PREFIX.length)),
      actor: claimed.actor ?? 'operator'
    })
  }
  if (args[0] === 'api') {
    return ok(`${world.main}\n`)
  }
  if (args[0] === 'workflow') {
    const workflow = Object.values(WORKFLOWS).find((candidate) => candidate.file === args[2])
    const inputs = JSON.parse(input)
    const run = {
      id: world.nextRunId++,
      file: workflow.file,
      name: workflow.name,
      inputs,
      key: `${workflow.file}:${inputs.mode ?? 'deploy'}`,
      dispatched: true,
      headSha: world.main,
      polls: world.polls?.[`${workflow.file}:${inputs.mode ?? 'deploy'}`] ?? 0,
      artifacts: {},
      log: ''
    }
    world.runs.push(run)
    simulate(world, run)
    return ok(
      world.printUrl ? `https://github.com/${REPOSITORY}/actions/runs/${run.id}\n` : 'Created\n'
    )
  }
  const run = world.runs.find((candidate) => candidate.id === Number(args[2]))
  if (args[1] === 'list') {
    const runs = world.runs
      .filter((candidate) => candidate.file === flag(args, '--workflow'))
      .toReversed()
    return ok(runs.map((candidate) => ({ databaseId: candidate.id })))
  }
  if (args[1] === 'view' && args.includes('--log')) {
    return world.unreadableLogs?.(run) ? { status: 1, stdout: '', stderr: 'HTTP 502' } : ok(run.log)
  }
  if (args[1] === 'view') {
    world.onView?.(run)
    const running = run.polls > 0
    if (running) {
      run.polls -= 1
    }
    return ok({
      status: running ? 'in_progress' : 'completed',
      conclusion: running ? '' : run.conclusion,
      attempt: 1,
      headSha: run.headSha,
      headBranch: 'main',
      event: 'workflow_dispatch',
      workflowName: run.name
    })
  }
  if (args[1] === 'download') {
    const files = run.artifacts[flag(args, '-n')]
    if (!files) {
      return { status: 1, stdout: '', stderr: 'no artifact' }
    }
    for (const [name, content] of Object.entries(files)) {
      writeFileSync(join(flag(args, '-D'), name), content)
    }
    return ok('')
  }
  throw new Error(`unexpected gh ${args.join(' ')}`)
}

export function gcloud(world, args) {
  const ok = (value) => ({
    status: 0,
    stdout: typeof value === 'string' ? value : JSON.stringify(value),
    stderr: ''
  })
  if (args[1] === 'services') {
    return ok({
      status: {
        traffic: [
          { revisionName: world.serving.revision, percent: 100 },
          { revisionName: world.rollback.revision, percent: 0, tag: 'selector-rollback' }
        ]
      }
    })
  }
  if (args[1] === 'revisions') {
    const revision = [world.serving, world.rollback].find(
      (candidate) => candidate.revision === args[3]
    )
    const cells = JSON.stringify(world.cells.map((id) => ({ id })))
    return ok({
      metadata: { creationTimestamp: new Date(revision.createdAt ?? START).toISOString() },
      spec: {
        containers: [
          {
            image: `${IMAGE_REPOSITORY}@${revision.digest}`,
            env: [{ name: 'ORCA_RELAY_CELLS_JSON', value: cells }]
          }
        ]
      }
    })
  }
  if (args[0] === 'artifacts') {
    return ok(`${world.registry[args[4]] ?? ''}\n`)
  }
  if (args[0] === 'logging') {
    const [, from, to] = args[2].match(/timestamp>="([^"]+)" AND timestamp<"([^"]+)"/)
    world.reads = [
      ...(world.reads ?? []),
      { from: Date.parse(from), to: Date.parse(to), readAt: world.now }
    ]
    return ok('t\n'.repeat(world.director5xx(Date.parse(from), Date.parse(to))))
  }
  throw new Error(`unexpected gcloud ${args.join(' ')}`)
}

export function dependencies(world) {
  return {
    run: (program, args, input) =>
      program === 'gh' ? gh(world, args, input) : gcloud(world, args),
    now: () => world.now,
    sleep: async (ms) => {
      world.now += ms
    },
    print: (line) => {
      // Every command the driver prints must be one its own parser accepts.
      for (const [, argv] of line.matchAll(/drive-relay-director-deploy\.mjs ([^*]+?)\s*$/g)) {
        assert.doesNotThrow(() => parseDriverArguments(argv.split(' ')), line)
      }
      world.printed.push(line)
    },
    prompt: async (question) => {
      world.questions = [...(world.questions ?? []), question]
      const answer = world.answer(question)
      world.prompts.push(question.match(/^Type (\S+(?: [0-9a-f]{12})?) to continue/)[1])
      return answer
    }
  }
}

export const logDirectory = () => mkdtempSync(join(tmpdir(), 'relay-deploy-test-'))

export function drive(world, argv, deps = dependencies(world)) {
  return createDriver(
    parseDriverArguments([...argv, '--log-directory', logDirectory()]),
    deps
  ).run()
}

export const start = (world, extra = [], deps) => drive(world, ['--commit', COMMIT, ...extra], deps)

// Runs the last printed command, or the last one on a line containing `marker`.
export function rerun(world, marker = '') {
  const command = world.printed.findLast(
    (line) => line.includes(marker) && line.includes('drive-relay-director-deploy.mjs ')
  )
  const argv = command
    .slice(command.indexOf('.mjs ') + 5)
    .trim()
    .split(' ')
  world.printed.length = 0
  return drive(world, argv)
}

export const stopped = (promise) =>
  promise.then(
    () => assert.fail('expected the driver to stop'),
    (error) => error
  )

export function keys(world) {
  return world
    .dispatches()
    .map((run) => run.key.slice(RELAY_WORKFLOW_FILE_PREFIX.length).replace('.yml', ''))
}

export const dispatched = (world, key) => world.dispatches().filter((run) => run.key === key)
export const REHOME = (mode) => `${WORKFLOWS.rehome.file}:${mode}`
export const DEPLOY = `${WORKFLOWS.director.file}:deploy`
export const PUBLISH = `${WORKFLOWS.publish.file}:publish`
export const MONITOR = `${WORKFLOWS.monitor.file}:dry-run`
export const report = (world) => world.printed.join('\n')
export const live = (world) => [world.control.generation, world.control.enabled]
