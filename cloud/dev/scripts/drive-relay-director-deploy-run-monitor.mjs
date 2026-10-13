const WATCH_INTERVAL_MS = 10_000
const WATCH_REPORT_MS = 5 * 60_000
const LOG_ATTEMPTS = 6
const LOG_INTERVAL_MS = 10_000

export function workflowRunView(runId, repository, ghJson, words) {
  return ghJson(
    words(
      `run view ${runId} -R ${repository} --json status,conclusion,attempt,headSha,headBranch,event,workflowName`
    )
  )
}

export async function waitForWorkflowRun(run, { viewRun, log, now, sleep }) {
  const started = now()
  let reported
  let reportedAt
  for (;;) {
    const view = viewRun(run.runId)
    if (view.status === 'completed') {
      log(`${run.name}: ${view.conclusion} ${run.url}`)
      return { ...run, conclusion: view.conclusion, attempt: view.attempt }
    }
    if (view.status !== reported || now() - reportedAt >= WATCH_REPORT_MS) {
      const minutes = Math.floor((now() - started) / 60_000)
      log(`${run.name}: ${view.status}, ${minutes} min`)
      reported = view.status
      reportedAt = now()
    }
    await sleep(WATCH_INTERVAL_MS)
  }
}

export async function readWorkflowRunLog(runId, { repository, gh, words, runUrl, sleep }) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      const text = gh(words(`run view ${runId} -R ${repository} --log`))
      if (text.trim()) {
        return text
      }
    } catch (error) {
      if (attempt >= LOG_ATTEMPTS) {
        throw new Error(`log for ${runUrl(runId)} is unavailable: ${error.message}`)
      }
    }
    if (attempt >= LOG_ATTEMPTS) {
      throw new Error(`log for ${runUrl(runId)} is empty`)
    }
    await sleep(LOG_INTERVAL_MS)
  }
}
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { verifyDryRunAuthority } from './relay-monitor-evidence.mjs'

export async function readWorkflowArtifact(
  runId,
  artifact,
  { download, createTemp, removeTemp, read }
) {
  const directory = createTemp()
  try {
    download(runId, artifact, directory)
    return await read(directory)
  } finally {
    removeTemp(directory)
  }
}

export async function monitorWorkflowEvidence(run, { readArtifact, now, log, DriverStop }) {
  const incidentId = `relay-${run.runId}-dry-run`
  return await readArtifact(
    run.runId,
    `relay-monitor-dry-run-${run.runId}-${run.attempt}`,
    async (directory) => {
      try {
        const argv = Object.entries({
          directory,
          'incident-id': incidentId,
          'run-id': run.runId,
          'run-attempt': run.attempt,
          'commit-sha': run.headSha,
          mode: 'dry-run',
          'required-migration-policy': 'strict'
        }).flatMap(([key, value]) => [`--${key}`, String(value)])
        const { state } = await verifyDryRunAuthority(argv, now)
        log(`monitor GREEN, completed ${state.completedAt}`)
        return state.completedAt
      } catch (error) {
        const sealed = (() => {
          try {
            return JSON.parse(readFileSync(join(directory, `${incidentId}.state.json`), 'utf8'))
          } catch {
            return {}
          }
        })()
        const failures = (sealed.failures ?? []).map((failure) =>
          [failure.source, failure.code, failure.signal, failure.observed, failure.threshold].join(
            ' '
          )
        )
        throw new DriverStop(
          [
            `monitor ${run.url} is not usable: ${error.message}`,
            `frozenAt ${sealed.frozenAt}`,
            ...failures
          ].join('\n  ')
        )
      }
    }
  )
}

export function createWorkflowEvidenceReader({
  repository,
  gh,
  words,
  runUrl,
  sleep,
  createTemp,
  removeTemp,
  rehomeResultFromLog
}) {
  const runLog = (runId) => readWorkflowRunLog(runId, { repository, gh, words, runUrl, sleep })

  async function rehomeResult(runId) {
    try {
      return rehomeResultFromLog(await runLog(runId))
    } catch {
      return undefined
    }
  }

  const withArtifact = (runId, artifact, read) =>
    readWorkflowArtifact(runId, artifact, {
      download: (id, name, directory) =>
        gh(words(`run download ${id} -R ${repository} -n ${name} -D ${directory}`)),
      createTemp,
      removeTemp,
      read
    })

  return { runLog, rehomeResult, withArtifact }
}

export function createWorkflowRunWatcher({ repository, ghJson, words, log, now, sleep }) {
  const viewRun = (runId) => workflowRunView(runId, repository, ghJson, words)
  const waitForRun = (run) => waitForWorkflowRun(run, { viewRun, log, now, sleep })
  return { viewRun, waitForRun }
}
