export function createWorkflowDispatcher({
  repository,
  workflowRef,
  gh,
  words,
  validateDispatchInputs,
  view,
  requireQuietLane,
  log,
  getUncertain,
  setUncertain,
  ownRunIds,
  runUrl,
  viewRun,
  waitForRun,
  DriverStop
}) {
  async function dispatch({ name, workflow, inputs: build, changesRehome = false }) {
    const inputs = validateDispatchInputs(build(view()))
    await new Promise((resolveYield) => setImmediate(resolveYield))
    requireQuietLane()
    log(`dispatch ${name}: ${workflow.file} ${JSON.stringify(inputs)}`)
    if (changesRehome) {
      setUncertain({ kind: 'changing', name })
    }
    const output = gh(
      words(`workflow run ${workflow.file} -R ${repository} --ref ${workflowRef} --json`),
      JSON.stringify(inputs)
    )
    const printed = output.match(/\/actions\/runs\/([0-9]+)/)
    if (!printed) {
      throw new DriverStop(
        `gh printed no run URL for ${workflow.file}; upgrade gh. The run may exist: find it before re-running`
      )
    }
    const runId = Number(printed[1])
    const url = runUrl(runId)
    ownRunIds.add(runId)
    if (changesRehome) {
      Object.assign(getUncertain(), { runId, url })
    }
    log(`${name}: run ${url}`)
    const dispatched = viewRun(runId)
    if (
      dispatched.workflowName !== workflow.name ||
      dispatched.event !== 'workflow_dispatch' ||
      dispatched.headBranch !== workflowRef
    ) {
      throw new DriverStop(
        `run ${runUrl(runId)} is not a ${workflow.file} dispatch on ${workflowRef}`
      )
    }
    return await waitForRun({ name, runId, url, headSha: dispatched.headSha })
  }

  function requireSuccess(run) {
    if (run.conclusion !== 'success') {
      throw new DriverStop(`${run.name} run ${run.url} concluded ${run.conclusion}`)
    }
  }

  return { dispatch, requireSuccess }
}

export function createWorkflowLaneMonitor({
  activeStatuses,
  repository,
  gh,
  words,
  blocksDeploy,
  ownRunIds,
  runUrl,
  DriverStop
}) {
  function activeRuns() {
    const active = []
    for (const status of activeStatuses) {
      const lines = gh(
        words(
          `api --paginate -X GET repos/${repository}/actions/runs -f status=${status} -f per_page=100 --jq .workflow_runs[]|{id,path,name,status}`
        )
      )
      for (const run of lines.split('\n').filter(Boolean).map(JSON.parse)) {
        if (blocksDeploy(run.path) && !ownRunIds.has(run.id)) {
          active.push(`${run.name} ${runUrl(run.id)} (${run.status})`)
        }
      }
    }
    return active
  }

  function requireQuietLane() {
    const active = activeRuns()
    if (active.length > 0) {
      throw new DriverStop(
        `relay workflows are in flight; wait for them:\n  ${active.join('\n  ')}`
      )
    }
  }

  return { activeRuns, requireQuietLane }
}
