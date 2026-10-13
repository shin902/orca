export function createDriverPreflight(context) {
  const {
    config,
    log,
    activeRuns,
    requireQuietLane,
    ghJson,
    words,
    repository,
    workflows,
    getLogin,
    gh,
    workflowRef,
    getPublished,
    getOwned,
    runUrl,
    rehomeResult,
    pausedGeneration,
    publishedDigest,
    publishStep,
    known,
    readDirector,
    setRollbackPoint,
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
    setOwned,
    setEnabled
  } = context

  async function preflight() {
    log('preflight: relay workflow lane, target commit, serving director')
    if (config.dryRun) {
      const active = activeRuns()
      if (active.length > 0) {
        log(
          `WARNING relay workflows are in flight; a real run would stop:\n  ${active.join('\n  ')}`
        )
      }
    } else {
      requireQuietLane()
    }
    let claim
    if (config.pauseRun) {
      // Only this operator's own rehome-control run can prove a pause belongs to this driver.
      const claimed = ghJson(
        words(
          `api repos/${repository}/actions/runs/${config.pauseRun} --jq {path,actor:.triggering_actor.login}`
        )
      )
      if (
        !claimed.path?.split('@')[0].endsWith(`/${workflows.rehome.file}`) ||
        claimed.actor !== getLogin()
      ) {
        throw new DriverStop(
          `${runUrl(config.pauseRun)} is not a ${workflows.rehome.file} run by ${getLogin()}, so it cannot prove a pause is this driver's`
        )
      }
      const result = await rehomeResult(config.pauseRun)
      claim = result && pausedGeneration(result)
      if (claim === undefined) {
        throw new DriverStop(
          `${runUrl(config.pauseRun)} printed no pause of its own, so it cannot prove a pause is this driver's`
        )
      }
    }
    if (getPublished()) {
      getPublished().digest = await publishedDigest(getPublished().runId)
    } else {
      const main = gh(['api', `repos/${repository}/commits/${workflowRef}`, '--jq', '.sha']).trim()
      if (main !== config.commit) {
        throw new DriverStop(
          `${workflowRef} is at ${main}, not the reviewed ${config.commit}; review the difference and run with --commit ${main}`
        )
      }
      // The workflow builds main's head at dispatch, so it is dispatched seconds after the check
      // rather than after the inspects and the typed phrase; publishing changes nothing serving.
      if (!config.dryRun) {
        await publishStep()
      }
    }
    known.director = readDirector()
    if (known.director.servingDigest !== getPublished()?.digest) {
      setRollbackPoint({
        revision: known.director.servingRevision,
        digest: known.director.servingDigest
      })
    }
    log(describeDirector(known.director))
    // A director safety pause moves the generation without a run; the inspect then fails closed.
    const generation = config.rehomeGeneration ?? (await lastKnownRehomeGeneration())
    if (config.dryRun) {
      known.control = undefined
      return generation
    }
    const [admissionStep, inspectStep] = readSteps(generation)
    const admission = await dispatch(admissionStep)
    requireSuccess(admission)
    known.selector = await withArtifact(
      admission.runId,
      `relay-asia-admission-result-${admission.runId}-${admission.attempt}`,
      (directory) =>
        admissionInspectResult(JSON.parse(readFileSync(join(directory, 'result.json'), 'utf8')))
    )
    const inspect = await dispatch(inspectStep)
    if (inspect.conclusion !== 'success') {
      throw new DriverStop(
        `rehome inspect at generation ${generation} failed (${inspect.url}): the generation, selector or a digest moved. A director safety pause bumps the generation. Read the log, then pass --rehome-generation`
      )
    }
    known.control = (await rehomeResult(inspect.runId))?.control
    if (!known.control) {
      throw new DriverStop(`rehome inspect ${inspect.url} printed no control`)
    }
    const control = known.control
    log(
      `rehome: generation ${control.generation}, ${control.enabled ? 'ENABLED' : 'disabled'}; selector generation ${known.selector.generation}`
    )
    if (claim !== undefined) {
      if (!control.enabled && control.generation === claim) {
        setOwned({ generation: claim, runId: config.pauseRun })
      } else if (control.enabled && control.generation === claim + 1) {
        setEnabled(true)
      } else {
        throw new DriverStop(
          `rehome is generation ${control.generation} ${control.enabled ? 'enabled' : 'paused'}, not the pause ${runUrl(config.pauseRun)} made at ${claim}. Something else changed it, such as a director safety pause; this driver will not touch it`
        )
      }
    } else if (control.enabled && config.leaveRehomePaused) {
      throw new DriverStop(
        'rehome is enabled; --leave-rehome-paused accepts only a paused switch. Drop it'
      )
    } else if (!control.enabled && !config.leaveRehomePaused) {
      throw new DriverStop(
        `rehome is paused at generation ${control.generation}, and this run did not pause it. If an earlier run of this driver did, re-run with the --pause-run its log printed. Otherwise pass --leave-rehome-paused to deploy and leave it paused`
      )
    }
    if (control.hostCooldownMs === undefined && (control.enabled || getOwned())) {
      throw new DriverStop(
        'the director reports no per-host rehome cooldown, so enable would refuse; not pausing'
      )
    }
    return generation
  }

  return preflight
}
