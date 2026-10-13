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

test('inspects generation zero without requiring target registration or making a mutation', async () => {
  const subject = harness({
    generation: 0,
    membership: {
      existingOnly: ['staging-gce-c3'],
      migrationOnly: [],
      general: ['staging-gce-c1', 'staging-gce-c2']
    }
  })
  const result = await operateRelayAsiaAdmission({
    environment: 'staging', mode: 'inspect', cells: ['staging-gce-c4'],
    imageDigest: digest, token: 'not-logged'
  }, subject)
  assert.equal(result.generation, 0)
  assert.equal(result.states['staging-gce-c4'], 'absent')
  assert.deepEqual(result.membership, subject.selector().membership)
  assert.equal(result.membershipSha256, membershipDigest(subject.selector().membership))
  assert.deepEqual(subject.requests.map(({ path }) => path), [
    '/v1/admin/admission-selector/status'
  ])
})

test('initializes generation zero without changing membership', async () => {
  const membership = {
    existingOnly: ['staging-gce-c3'],
    migrationOnly: [],
    general: ['staging-gce-c1', 'staging-gce-c2']
  }
  const subject = harness({ generation: 0, membership })
  const result = await operateRelayAsiaAdmission({
    environment: 'staging', mode: 'initialize', cells: ['staging-gce-c4'],
    expectedGeneration: 0, imageDigest: digest,
    expectedMembershipSha256: membershipDigest(membership),
    attemptId: 'asia_boundary_0', token: 'not-logged'
  }, subject)
  const request = subject.requests.find(({ path }) => path.endsWith('/apply'))
  assert.deepEqual(request.body, {
    v: 1,
    attemptId: 'asia_boundary_0',
    expectedGeneration: 0,
    expectedMembershipSha256: membershipDigest(membership),
    membership
  })
  assert.equal(result.generation, 1)
  assert.equal(result.states['staging-gce-c4'], 'absent')
  assert.deepEqual(subject.selector().membership, membership)
})

test('retries the same fingerprint-bound initialization after intent persistence', async () => {
  const membership = {
    existingOnly: ['staging-gce-c3'],
    migrationOnly: [],
    general: ['staging-gce-c1', 'staging-gce-c2']
  }
  const subject = harness({ generation: 0, membership })
  subject.failNextApplyAfterIntent()
  const result = await operateRelayAsiaAdmission({
    environment: 'staging', mode: 'initialize', cells: ['staging-gce-c4'],
    expectedGeneration: 0, imageDigest: digest,
    expectedMembershipSha256: membershipDigest(membership),
    attemptId: 'asia_boundary_intent_retry', token: 'not-logged'
  }, subject)
  const applies = subject.requests.filter(({ path }) => path.endsWith('/apply'))
  assert.equal(applies.length, 2)
  assert.deepEqual(applies[1].body, applies[0].body)
  assert.equal(result.recovered, true)
  assert.equal(result.generation, 1)
  assert.deepEqual(subject.selector().membership, membership)
})

test('recovers a committed generation-zero initialization', async () => {
  const membership = {
    existingOnly: ['staging-gce-c3'],
    migrationOnly: [],
    general: ['staging-gce-c1', 'staging-gce-c2']
  }
  const subject = harness({ generation: 0, membership })
  const config = {
    environment: 'staging', mode: 'initialize', cells: ['staging-gce-c4'],
    expectedGeneration: 0, imageDigest: digest,
    expectedMembershipSha256: membershipDigest(membership),
    attemptId: 'asia_boundary_retry', token: 'not-logged'
  }
  await assert.rejects(subject.commitWithoutResponse(
    '/v1/admin/admission-selector/apply',
    {
      v: 1,
      attemptId: config.attemptId,
      expectedGeneration: 0,
      expectedMembershipSha256: membershipDigest(membership),
      membership
    }
  ), /response lost after commit/)
  const recovered = await operateRelayAsiaAdmission(config, subject)
  assert.equal(recovered.recovered, true)
  assert.equal(recovered.generation, 1)
  assert.deepEqual(subject.selector().membership, membership)
})

test('rejects generation-zero membership drift after inspect', async () => {
  const inspected = {
    existingOnly: ['staging-gce-c3'],
    migrationOnly: [],
    general: ['staging-gce-c1', 'staging-gce-c2']
  }
  const changed = {
    existingOnly: ['staging-gce-c2', 'staging-gce-c3'],
    migrationOnly: [],
    general: ['staging-gce-c1']
  }
  const subject = harness({ generation: 0, membership: changed })
  await assert.rejects(operateRelayAsiaAdmission({
    environment: 'staging', mode: 'initialize', cells: ['staging-gce-c4'],
    expectedGeneration: 0, imageDigest: digest,
    expectedMembershipSha256: membershipDigest(inspected),
    attemptId: 'asia_boundary_drift', token: 'not-logged'
  }, subject), /membership changed/)
  assert.equal(subject.requests.some(({ path }) => path.endsWith('/apply')), false)
})

test('registers all three Asia cells atomically with region and exact limits', async () => {
  const subject = harness(baseSelector)
  const result = await operateRelayAsiaAdmission({
    environment: 'production', mode: 'register',
    cells: ['production-gce-c27', 'production-gce-c28', 'production-gce-c29'],
    expectedGeneration: 7, imageDigest: digest, attemptId: 'asia_register_7', token: 'not-logged'
  }, subject)
  const request = subject.requests.find(({ path }) => path.endsWith('/add-migration-cells'))
  assert.equal(request.body.cells.length, 3)
  assert.ok(request.body.cells.every((cell) =>
    cell.region === 'asia-east2' && cell.capacityRequests === 6_000 &&
    cell.connectionHardCap === 3_000 && cell.connectionUnobservedBound === 60
  ))
  assert.equal(result.generation, 8)
  assert.deepEqual(new Set(Object.values(result.states)), new Set(['migration-only']))
})

test('promotes the canary only after runtime and director-heartbeat checks', async () => {
  const subject = harness({
    generation: 8,
    membership: { existingOnly: [], migrationOnly: ['production-gce-c27'], general: ['production-gce-c26'] }
  })
  const result = await operateRelayAsiaAdmission({
    environment: 'production', mode: 'promote', cells: ['production-gce-c27'],
    expectedGeneration: 8, imageDigest: digest, attemptId: 'asia_promote_8', token: 'not-logged'
  }, subject)
  assert.equal(subject.fetchCount(), 2)
  assert.equal(result.states['production-gce-c27'], 'general')
})

test('checks registered migration-only cells before director configuration without requiring heartbeat', async () => {
  const subject = harness({
    generation: 8,
    membership: {
      existingOnly: [],
      migrationOnly: ['production-gce-c27', 'production-gce-c28', 'production-gce-c29'],
      general: ['production-gce-c26']
    }
  })
  const result = await operateRelayAsiaAdmission({
    environment: 'production', mode: 'registered',
    cells: ['production-gce-c27', 'production-gce-c28', 'production-gce-c29'],
    expectedGeneration: 8, imageDigest: digest, token: 'not-logged'
  }, subject)
  assert.equal(subject.fetchCount(), 6)
  assert.equal(subject.requests.filter(({ path }) => path === '/v1/admin/cell-status').length, 0)
  assert.deepEqual(new Set(Object.values(result.states)), new Set(['migration-only']))
})

test('rolls back admission without requiring an unhealthy runtime to answer', async () => {
  const subject = harness({
    generation: 9,
    membership: { existingOnly: [], migrationOnly: [], general: ['production-gce-c26', 'production-gce-c27'] }
  })
  const result = await operateRelayAsiaAdmission({
    environment: 'production', mode: 'rollback', cells: ['production-gce-c27'],
    expectedGeneration: 9, imageDigest: digest, attemptId: 'asia_rollback_9', token: 'not-logged'
  }, subject)
  assert.equal(subject.fetchCount(), 0)
  assert.equal(result.states['production-gce-c27'], 'migration-only')
})

test('uses the server-enforced C4-only route for staging proof transitions', async () => {
  const subject = harness({
    generation: 3,
    membership: {
      existingOnly: ['staging-gce-c1'],
      migrationOnly: [],
      general: ['staging-gce-c2', 'staging-gce-c4']
    }
  })
  const result = await operateRelayAsiaAdmission({
    environment: 'staging', mode: 'rollback', cells: ['staging-gce-c4'],
    expectedGeneration: 3, imageDigest: digest, attemptId: 'asia_staging_rollback',
    token: 'not-logged'
  }, subject)
  const request = subject.requests.find(
    ({ path }) => path.endsWith('/apply-staging-asia-proof')
  )
  assert.deepEqual(request.body, {
    v: 1,
    attemptId: 'asia_staging_rollback',
    expectedGeneration: 3,
    state: 'migration-only'
  })
  assert.deepEqual(subject.selector().membership, {
    existingOnly: ['staging-gce-c1'],
    migrationOnly: ['staging-gce-c4'],
    general: ['staging-gce-c2']
  })
  assert.equal(result.states['staging-gce-c4'], 'migration-only')
})

test('fails closed when the exact selector generation moved', async () => {
  const subject = harness(baseSelector)
  await assert.rejects(operateRelayAsiaAdmission({
    environment: 'production', mode: 'register',
    cells: ['production-gce-c27', 'production-gce-c28', 'production-gce-c29'],
    expectedGeneration: 6, imageDigest: digest, attemptId: 'asia_register_6', token: 'not-logged'
  }, subject), /generation changed/)
  assert.equal(subject.fetchCount(), 0)
})

test('recovers a committed registration when the workflow retries the original generation', async () => {
  const subject = harness(baseSelector)
  const config = {
    environment: 'production', mode: 'register',
    cells: ['production-gce-c27', 'production-gce-c28', 'production-gce-c29'],
    expectedGeneration: 7, imageDigest: digest, attemptId: 'asia_register_retry',
    token: 'not-logged'
  }
  await assert.rejects(subject.commitWithoutResponse(
    '/v1/admin/admission-selector/add-migration-cells',
    {
      v: 1,
      attemptId: config.attemptId,
      expectedGeneration: config.expectedGeneration,
      cells: config.cells.map((cellId) => ({ cellId }))
    }
  ), /response lost after commit/)
  const recovered = await operateRelayAsiaAdmission(config, subject)
  assert.equal(recovered.recovered, true)
  assert.equal(recovered.generation, 8)
})
