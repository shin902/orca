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

test('recovers a committed promotion when the workflow retries the original generation', async () => {
  const subject = harness({
    generation: 8,
    membership: {
      existingOnly: [], migrationOnly: ['production-gce-c27'], general: ['production-gce-c26']
    }
  })
  const config = {
    environment: 'production', mode: 'promote', cells: ['production-gce-c27'],
    expectedGeneration: 8, imageDigest: digest, attemptId: 'asia_promote_retry',
    token: 'not-logged'
  }
  await assert.rejects(subject.commitWithoutResponse(
    '/v1/admin/admission-selector/apply',
    {
      v: 1,
      attemptId: config.attemptId,
      expectedGeneration: config.expectedGeneration,
      membership: {
        existingOnly: [], migrationOnly: [],
        general: ['production-gce-c26', 'production-gce-c27']
      }
    }
  ), /response lost after commit/)
  const recovered = await operateRelayAsiaAdmission(config, subject)
  assert.equal(recovered.recovered, true)
  assert.equal(recovered.generation, 9)
  assert.equal(recovered.states['production-gce-c27'], 'general')
})

test('inspects an ambiguous promotion without creating a new transition', async () => {
  const untouched = harness({
    generation: 8,
    membership: {
      existingOnly: [], migrationOnly: ['production-gce-c27'], general: ['production-gce-c26']
    }
  })
  const config = {
    environment: 'production', mode: 'recover-promotion', cells: ['production-gce-c27'],
    expectedGeneration: 8, imageDigest: digest, attemptId: 'asia_recover_promote',
    token: 'not-logged'
  }
  const absent = await operateRelayAsiaAdmission(config, untouched)
  assert.equal(absent.promoted, false)
  assert.equal(untouched.requests.some(({ path }) => path.endsWith('/apply')), false)

  const committed = harness({
    generation: 8,
    membership: {
      existingOnly: [], migrationOnly: ['production-gce-c27'], general: ['production-gce-c26']
    }
  })
  await assert.rejects(committed.commitWithoutResponse('/v1/admin/admission-selector/apply', {
    v: 1,
    attemptId: config.attemptId,
    expectedGeneration: 8,
    membership: {
      existingOnly: [], migrationOnly: [], general: ['production-gce-c26', 'production-gce-c27']
    }
  }), /response lost after commit/)
  const recovered = await operateRelayAsiaAdmission(config, committed)
  assert.equal(recovered.promoted, true)
  assert.equal(recovered.generation, 9)
})

test('treats an already rolled-back promotion as recovered', async () => {
  const subject = harness({
    generation: 8,
    membership: {
      existingOnly: [], migrationOnly: ['production-gce-c27'], general: ['production-gce-c26']
    }
  })
  const config = {
    environment: 'production', mode: 'recover-promotion', cells: ['production-gce-c27'],
    expectedGeneration: 8, imageDigest: digest, attemptId: 'asia_recover_after_rollback',
    token: 'not-logged'
  }
  await assert.rejects(subject.commitWithoutResponse('/v1/admin/admission-selector/apply', {
    v: 1, attemptId: config.attemptId, expectedGeneration: 8,
    membership: {
      existingOnly: [], migrationOnly: [], general: ['production-gce-c26', 'production-gce-c27']
    }
  }), /response lost after commit/)
  await subject.apply('later_rollback', {
    existingOnly: [], migrationOnly: ['production-gce-c27'], general: ['production-gce-c26']
  })
  const recovered = await operateRelayAsiaAdmission(config, subject)
  assert.equal(recovered.promoted, false)
  assert.equal(recovered.generation, 10)
})

test('recovers a committed rollback when the workflow retries the original generation', async () => {
  const subject = harness({
    generation: 9,
    membership: {
      existingOnly: [], migrationOnly: [], general: ['production-gce-c26', 'production-gce-c27']
    }
  })
  const config = {
    environment: 'production', mode: 'rollback', cells: ['production-gce-c27'],
    expectedGeneration: 9, imageDigest: digest, attemptId: 'asia_rollback_retry',
    token: 'not-logged'
  }
  await assert.rejects(subject.commitWithoutResponse(
    '/v1/admin/admission-selector/apply',
    {
      v: 1,
      attemptId: config.attemptId,
      expectedGeneration: config.expectedGeneration,
      membership: {
        existingOnly: [], migrationOnly: ['production-gce-c27'],
        general: ['production-gce-c26']
      }
    }
  ), /response lost after commit/)
  const recovered = await operateRelayAsiaAdmission(config, subject)
  assert.equal(recovered.recovered, true)
  assert.equal(recovered.generation, 10)
  assert.equal(recovered.states['production-gce-c27'], 'migration-only')
})

test('rejects a committed transition retry after a later selector change', async () => {
  const subject = harness({
    generation: 8,
    membership: {
      existingOnly: [], migrationOnly: ['production-gce-c27'], general: ['production-gce-c26']
    }
  })
  const config = {
    environment: 'production', mode: 'promote', cells: ['production-gce-c27'],
    expectedGeneration: 8, imageDigest: digest, attemptId: 'asia_stale_promote',
    token: 'not-logged'
  }
  await assert.rejects(subject.commitWithoutResponse('/v1/admin/admission-selector/apply', {
    v: 1, attemptId: config.attemptId, expectedGeneration: 8,
    membership: {
      existingOnly: [], migrationOnly: [], general: ['production-gce-c26', 'production-gce-c27']
    }
  }), /response lost after commit/)
  await subject.apply('later_rollback', {
    existingOnly: [], migrationOnly: ['production-gce-c27'], general: ['production-gce-c26']
  })
  await assert.rejects(
    operateRelayAsiaAdmission(config, subject),
    /does not match the requested Asia transition/
  )
})

test('requires the C27 canary before promoting C28 and C29', async () => {
  const subject = harness({
    generation: 8,
    membership: {
      existingOnly: [],
      migrationOnly: ['production-gce-c27', 'production-gce-c28', 'production-gce-c29'],
      general: ['production-gce-c26']
    }
  })
  await assert.rejects(operateRelayAsiaAdmission({
    environment: 'production', mode: 'promote',
    cells: ['production-gce-c28', 'production-gce-c29'], expectedGeneration: 8,
    imageDigest: digest, attemptId: 'asia_wave_before_canary', token: 'not-logged'
  }, subject), /C27 canary/)
})

