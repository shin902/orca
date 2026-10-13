const TRAFFIC_SWITCH_LEAD_MS = 60_000
const LOG_INGESTION_LAG_MS = 60_000
const LOG_COUNT_LIMIT = 5_000

export const SOAK_MS = 5 * 60_000

export function countDirector5xx({ fromMs, toMs, service, project, command, timestamp }) {
  const filter = [
    'resource.type="cloud_run_revision"',
    `resource.labels.service_name="${service}"`,
    `logName="projects/${project}/logs/run.googleapis.com%2Frequests"`,
    'httpRequest.status>=500',
    `timestamp>=\"${timestamp(fromMs)}\"`,
    `timestamp<\"${timestamp(toMs)}\"`
  ].join(' AND ')
  return command('gcloud', [
    'logging',
    'read',
    filter,
    '--project',
    project,
    '--limit',
    String(LOG_COUNT_LIMIT),
    '--format=value(timestamp)'
  ])
    .split('\n')
    .filter(Boolean).length
}

export async function monitorDirectorSoak({
  deployedAt,
  createdAt,
  now,
  sleep,
  count5xx,
  log,
  timestamp
}) {
  const created = Date.parse(createdAt)
  const start =
    deployedAt === undefined ? now() : Math.max(deployedAt - TRAFFIC_SWITCH_LEAD_MS, created)
  const end = start + SOAK_MS
  const readAt = end + LOG_INGESTION_LAG_MS
  if (now() < readAt) {
    log(`soak: watching the new director until ${timestamp(end)}, reading at ${timestamp(readAt)}`)
    await sleep(readAt - now())
  }
  const before = count5xx(created - SOAK_MS, created)
  const after = count5xx(start, end)
  log(
    `soak: director 5xx ${after} in ${SOAK_MS / 60_000} min on the new image, ${before} before it`
  )
  if (after >= 5_000 || after > 2 * before + 25) {
    throw new Error(
      `director 5xx rose from ${before} to ${after} after the deploy; investigate before configuring cells`
    )
  }
}
