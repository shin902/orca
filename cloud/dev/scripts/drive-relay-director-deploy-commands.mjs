export function createRerunCommand({ config, getOwned, getPublished }) {
  return function rerunCommand(
    pauseRun = getOwned()?.runId,
    build = getPublished()?.digest
      ? { commit: config.commit, runId: getPublished().runId }
      : undefined
  ) {
    return [
      'node dev/scripts/drive-relay-director-deploy.mjs',
      `--commit ${build?.commit ?? config.commit}`,
      ...(build ? [`--publish-run ${build.runId}`] : []),
      ...(pauseRun ? [`--pause-run ${pauseRun}`] : []),
      ...(config.leaveRehomePaused ? ['--leave-rehome-paused'] : []),
      ...config.configure.map(
        (wave) => `--configure ${wave.cells.join(',')}=${wave.cellImageDigest}`
      )
    ].join(' ')
  }
}

export function buildWorkflowCommand(workflow, inputs, { repository, workflowRef }) {
  const fields = Object.entries(inputs).map(([key, value]) => `-f ${key}=${value}`)
  return `gh workflow run ${workflow.file} -R ${repository} --ref ${workflowRef} ${fields.join(' ')}`
}
