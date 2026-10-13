export function createStopReport({
  reason,
  repository,
  workflows,
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
}) {
  const lines = [`STOPPED: ${reason}`, '', 'State now:']
  const workflowPage = `https://github.com/${repository}/actions/workflows/${workflows.rehome.file}`
  const where = uncertain?.url ?? `(gh printed no URL; find it at ${workflowPage})`
  if (uncertain?.name === 'pause') {
    lines.push(
      uncertain.kind === 'changing'
        ? `- *** REHOME IS CHANGING: the pause run ${where} was dispatched and applies on its own, if it has not already. ***`
        : `- *** PAUSE UNCONFIRMED: ${where} printed no pause. Rehome MAY BE PAUSED. ***`,
      '  Inspect rehome before walking away.'
    )
    if (uncertain.runId) {
      lines.push(
        `  If it paused rehome at generation ${known.control.generation + 1}, finish with: cd cloud && ${rerunCommand(uncertain.runId)}`
      )
    }
  } else if (uncertain?.name === 'enable') {
    lines.push(
      uncertain.kind === 'changing'
        ? `- *** REHOME IS CHANGING: the enable run ${where} applies on its own: it enables rehome, or disables it again if it fails. ***`
        : `- *** ENABLE UNCONFIRMED: ${where} did not confirm the enable. Rehome may be enabled, or paused. ***`,
      `  If it enabled rehome, or failed before applying, finish with: cd cloud && ${rerunCommand(owned.runId)}`
    )
    if (uncertain.runId) {
      lines.push(
        `  If its recovery paused rehome again, finish with: cd cloud && ${rerunCommand(uncertain.runId)}`
      )
    }
  } else if (owned) {
    lines.push(
      `- *** REHOME IS PAUSED by this driver at generation ${owned.generation} (${runUrl(owned.runId)}). It stays paused until the re-run below enables it. ***`
    )
  } else if (known.control) {
    const state =
      enabled || known.control.enabled
        ? 'enabled'
        : 'PAUSED, not by this driver; it will not be re-enabled here'
    lines.push(`- rehome: generation ${known.control.generation} as last read, ${state}`)
  } else {
    lines.push('- rehome: not read; this run did not change it')
  }
  try {
    lines.push(`- director now: ${describeDirector(readDirector())}`)
  } catch (error) {
    lines.push(`- director: could not re-read (${error.message})`)
  }
  if (published?.digest) {
    lines.push(`- published: ${published.digest} (${runUrl(published.runId)})`)
  }
  if (rollbackPoint) {
    lines.push(
      `- rollback point: ${rollbackPoint.revision} ${rollbackPoint.digest}. To undo the deploy, while rehome is paused:`
    )
    lines.push(
      `  ${ghCommand(workflows.director, directorDeployInputs({ imageDigest: rollbackPoint.digest, predecessorDigest: rollbackPoint.digest, rehomeGeneration: owned?.generation ?? '<paused generation>' }))}`
    )
  }
  if (movedBuild) {
    lines.push(
      '',
      `Review ${config.commit}..${movedBuild.commit}, then deploy that build without rebuilding:`,
      `  cd cloud && ${rerunCommand(undefined, movedBuild)}`
    )
  } else if (!config.dryRun && !uncertain) {
    lines.push(
      '',
      'Re-run to finish from here (it re-reads everything and skips what is done):',
      `  cd cloud && ${rerunCommand()}`
    )
  }
  return lines.join('\n')
}
