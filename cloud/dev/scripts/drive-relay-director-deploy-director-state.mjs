import {
  DIRECTOR_SERVICE,
  REGION,
  directorRevisions,
  revisionDigest
} from './relay-director-deploy-plan.mjs'

export function readDirectorState(gcloudJson, words) {
  const service = gcloudJson(words(`run services describe ${DIRECTOR_SERVICE} --region ${REGION}`))
  const { servingRevision, rollbackRevision } = directorRevisions(service)
  const describe = (revision) =>
    gcloudJson(words(`run revisions describe ${revision} --region ${REGION}`))
  const serving = describe(servingRevision)
  const cellsJson = serving.spec.containers[0].env?.find(
    (variable) => variable.name === 'ORCA_RELAY_CELLS_JSON'
  )?.value
  return {
    servingRevision,
    servingDigest: revisionDigest(serving, `revision ${servingRevision}`),
    servingCreatedAt: serving.metadata?.creationTimestamp,
    cells: new Set(JSON.parse(cellsJson ?? '[]').map((cell) => cell.id)),
    rollbackRevision,
    rollbackDigest: revisionDigest(describe(rollbackRevision), `revision ${rollbackRevision}`)
  }
}

export function describeDirectorState(director) {
  return `serving ${director.servingRevision} ${director.servingDigest}; rollback ${director.rollbackRevision} ${director.rollbackDigest}`
}
