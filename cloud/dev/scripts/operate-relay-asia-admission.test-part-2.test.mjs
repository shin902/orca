import assert from 'node:assert/strict'

import { spawnSync } from 'node:child_process'

import { createHash } from 'node:crypto'

import { mkdtempSync, readFileSync, rmSync } from 'node:fs'

import { tmpdir } from 'node:os'

import { join } from 'node:path'

import { test } from 'node:test'

import {
  operateRelayAsiaAdmission,
  parseRelayAsiaAdmissionArguments
} from './operate-relay-asia-admission.mjs'

import { readRelayWorkflow } from './relay-repository.mjs'


import {
  digest,
  membershipDigest,
  harness,
  baseSelector
} from './operate-relay-asia-admission.test-support.mjs'
import { launchCells, admissionArguments } from './operate-relay-asia-admission.test-support.mjs'

test('promotes the registered C34 spare to general and leaves every other cell alone', async () => {
  const general = [
    ...launchCells, 'production-gce-c30', 'production-gce-c31', 'production-gce-c32', 'production-gce-c33'
  ]
  const membership = {
    existingOnly: [],
    migrationOnly: ['production-gce-c17', 'production-gce-c34'],
    general: [...general]
  }
  const subject = harness({ generation: 345, membership })
  const result = await operateRelayAsiaAdmission({
    environment: 'production', mode: 'promote', cells: ['production-gce-c34'],
    expectedGeneration: 345, imageDigest: digest, attemptId: 'asia_promote_c34', token: 'not-logged'
  }, subject)
  assert.deepEqual(result.states, { 'production-gce-c34': 'general' })
  assert.deepEqual(subject.selector().membership.migrationOnly, ['production-gce-c17'])
  assert.deepEqual(subject.selector().membership.general, [...general, 'production-gce-c34'].sort())
})

const usRegions = { 'production-gce-c32': 'us-central1', 'production-gce-c33': 'us-central1' }

test('registers C32 and C33 one at a time in us-central1 at the Asia shape', async () => {
  const general = [...launchCells, 'production-gce-c30', 'production-gce-c31']
  for (const [cellId, generation] of [['production-gce-c32', 13], ['production-gce-c33', 15]]) {
    const hostname = cellId.split('-').at(-1)
    const subject = harness({
      generation, membership: { existingOnly: [], migrationOnly: [], general: [...general] }
    }, {}, usRegions)
    const result = await operateRelayAsiaAdmission({
      environment: 'production', mode: 'register', cells: [cellId],
      expectedGeneration: generation, imageDigest: digest, attemptId: `us_register_${hostname}`,
      token: 'not-logged'
    }, subject)
    const request = subject.requests.find(({ path }) => path.endsWith('/add-migration-cells'))
    assert.deepEqual(request.body.cells, [{
      cellId, cellUrl: `https://${hostname}.relay.onorca.dev`, region: 'us-central1',
      capacityRequests: 6_000, connectionHardCap: 3_000, connectionUnobservedBound: 60
    }])
    assert.deepEqual(result.states, { [cellId]: 'migration-only' })
    // A US cell whose runtime reports Asia is the wrong cell, not a US one.
    await assert.rejects(operateRelayAsiaAdmission({
      environment: 'production', mode: 'register', cells: [cellId],
      expectedGeneration: generation, imageDigest: digest, attemptId: `us_register_${hostname}`,
      token: 'not-logged'
    }, harness({
      generation, membership: { existingOnly: [], migrationOnly: [], general: [...general] }
    })), new RegExp(`${cellId} runtime does not match`))
  }
})

test('promotes a US cell without the Asia launch order, which still binds Asia cells', async () => {
  const selector = (cellId) => ({
    generation: 14,
    membership: {
      existingOnly: [],
      migrationOnly: [cellId, 'production-gce-c27', 'production-gce-c28'].sort(),
      general: ['production-gce-c29']
    }
  })
  const config = (cellId) => ({
    environment: 'production', mode: 'promote', cells: [cellId],
    expectedGeneration: 14, imageDigest: digest, attemptId: 'us_promote_wave', token: 'not-logged'
  })
  const result = await operateRelayAsiaAdmission(
    config('production-gce-c32'), harness(selector('production-gce-c32'), {}, usRegions)
  )
  assert.deepEqual(result.states, { 'production-gce-c32': 'general' })
  await assert.rejects(
    operateRelayAsiaAdmission(config('production-gce-c31'), harness(selector('production-gce-c31'))),
    /C27 canary/
  )
})

test('requires the C27 canary to be general before promoting C30', async () => {
  const selector = (general) => ({
    generation: 10,
    membership: {
      existingOnly: [],
      migrationOnly: ['production-gce-c30', ...launchCells.filter((cell) => !general.includes(cell))].sort(),
      general
    }
  })
  const config = {
    environment: 'production', mode: 'promote', cells: ['production-gce-c30'],
    expectedGeneration: 10, imageDigest: digest, attemptId: 'asia_promote_c30', token: 'not-logged'
  }
  await assert.rejects(
    operateRelayAsiaAdmission(config, harness(selector(['production-gce-c28', 'production-gce-c29']))),
    /C27 canary/
  )
  await assert.rejects(
    operateRelayAsiaAdmission(config, harness(selector(['production-gce-c27', 'production-gce-c29']))),
    /every launch cell to be general/
  )
  const subject = harness(selector([...launchCells]))
  const result = await operateRelayAsiaAdmission(config, subject)
  assert.deepEqual(result.states, { 'production-gce-c30': 'general' })
  assert.equal(subject.requests.filter(({ path }) => path === '/v1/admin/cell-status').length, 1)
})

test('promotes C30 on its own digest while the launch cells serve another', async () => {
  const c30Digest = `sha256:${'b'.repeat(64)}`
  const selector = {
    generation: 10,
    membership: { existingOnly: [], migrationOnly: ['production-gce-c30'], general: [...launchCells] }
  }
  const config = {
    environment: 'production', mode: 'promote', cells: ['production-gce-c30'],
    expectedGeneration: 10, imageDigest: c30Digest, attemptId: 'asia_promote_c30', token: 'not-logged'
  }
  const digests = { 'production-gce-c30': c30Digest }
  const result = await operateRelayAsiaAdmission(config, harness(selector, digests))
  assert.deepEqual(result.states, { 'production-gce-c30': 'general' })
  await assert.rejects(
    operateRelayAsiaAdmission({ ...config, imageDigest: digest }, harness(selector, digests)),
    /production-gce-c30 runtime does not match/
  )
})

const admissionWorkflow = readRelayWorkflow('operate-relay-asia-admission.yml')

function workflowBlock(first, last) {
  const start = admissionWorkflow.indexOf(first)
  const end = admissionWorkflow.indexOf(last, start)
  assert.ok(start !== -1 && end !== -1, first)
  return admissionWorkflow.slice(start, end + last.length).replace(/^ {10}/gm, '')
}

// Runs the workflow's own promotion input block, so each wave's canary routing is what ships.
function promotionOutputs(cellIds) {
  const temp = mkdtempSync(join(tmpdir(), 'relay-admission-inputs-'))
  try {
    const output = join(temp, 'output')
    const result = spawnSync('bash', ['-c', workflowBlock(
      'set -euo pipefail\n          test -n "${DEPLOY_WORKLOAD_IDENTITY_PROVIDER}"',
      '} >> "${GITHUB_OUTPUT}"'
    )], {
      env: {
        ...process.env, GITHUB_OUTPUT: output, DEPLOY_WORKLOAD_IDENTITY_PROVIDER: 'provider',
        DEPLOY_SERVICE_ACCOUNT: 'account', IMAGE_DIGEST: digest, OPERATION_MODE: 'promote',
        EXPECTED_SELECTOR_GENERATION: '9', SELECTOR_ATTEMPT_ID: 'promote_wave_9',
        OPERATION_CONFIRMATION: 'PROMOTE_ASIA_GENERAL', TARGET_ENVIRONMENT: 'production',
        TARGET_CELL_IDS: cellIds, EXPECTED_SELECTOR_MEMBERSHIP_SHA256: '', DIRECTOR_IMAGE_DIGEST: '',
        EVIDENCE_RUN_ID: '', EVIDENCE_RUN_ATTEMPT: ''
      },
      encoding: 'utf8'
    })
    if (result.status !== 0) {return null}
    return Object.fromEntries(readFileSync(output, 'utf8').trim().split('\n')
      .map((line) => line.split('=')))
  } finally {
    rmSync(temp, { recursive: true, force: true })
  }
}

test('runs each later cell\'s own canary with load aimed at that cell\'s region', () => {
  for (const [cellId, region] of [
    ['production-gce-c30', 'asia-east2'], ['production-gce-c31', 'asia-east2'],
    ['production-gce-c32', 'us-central1'], ['production-gce-c33', 'us-central1'],
    ['production-gce-c34', 'asia-east2']
  ]) {
    const outputs = promotionOutputs(cellId)
    assert.equal(outputs?.canary, 'true', cellId)
    assert.equal(outputs.canary_cell, cellId)
    assert.equal(outputs.canary_region, region, cellId)
    assert.equal(outputs.evidence_kind, 'none')
  }
  assert.equal(promotionOutputs('production-gce-c32,production-gce-c33'), null)
  assert.equal(promotionOutputs('production-gce-c33,production-gce-c34'), null)
  const canaryStart = workflowBlock('case "${CANARY_CELL}" in', '\n          esac')
  for (const cellId of ['production-gce-c32', 'production-gce-c33', 'production-gce-c34']) {
    const result = spawnSync('bash', ['-euo', 'pipefail', '-c',
      `${canaryStart}\necho "\${verify_cells} \${expected_states}"`], {
      env: { ...process.env, CANARY_CELL: cellId }, encoding: 'utf8'
    })
    assert.equal(result.stdout.trim(), `${cellId} {"${cellId}":"general"}`)
  }
  assert.match(admissionWorkflow, /--preferred-region "\$\{CANARY_REGION\}"/)
  assert.match(admissionWorkflow, /CANARY_REGION: \$\{\{ steps\.inputs\.outputs\.canary_region \}\}/)
})
