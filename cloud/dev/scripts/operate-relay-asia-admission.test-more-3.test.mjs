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

test('accepts only reviewed Asia admission waves', () => {
  const accepted = [
    ['inspect', 'production-gce-c27,production-gce-c28,production-gce-c29'],
    ['inspect', 'production-gce-c30'],
    ['inspect', 'production-gce-c31'],
    ['verify', 'production-gce-c27,production-gce-c28,production-gce-c29'],
    ['verify', 'production-gce-c30'],
    ['verify', 'production-gce-c31'],
    ['initialize', 'production-gce-c27,production-gce-c28,production-gce-c29'],
    ['register', 'production-gce-c27,production-gce-c28,production-gce-c29'],
    ['register', 'production-gce-c30'],
    ['registered', 'production-gce-c30'],
    ['register', 'production-gce-c31'],
    ['registered', 'production-gce-c31'],
    ['promote', 'production-gce-c27'],
    ['promote', 'production-gce-c28,production-gce-c29'],
    ['promote', 'production-gce-c30'],
    ['recover-promotion', 'production-gce-c30'],
    ['promote', 'production-gce-c31'],
    ['recover-promotion', 'production-gce-c31'],
    ['rollback', 'production-gce-c27'],
    ['rollback', 'production-gce-c28,production-gce-c29'],
    ['rollback', 'production-gce-c30'],
    ['rollback', 'production-gce-c31'],
    ['rollback', 'production-gce-c27,production-gce-c28,production-gce-c29'],
    ['rollback', 'production-gce-c27,production-gce-c28,production-gce-c29,production-gce-c30,production-gce-c31,production-gce-c32,production-gce-c33,production-gce-c34'],
    ...['production-gce-c32', 'production-gce-c33'].flatMap((cellId) => [
      'inspect', 'verify', 'register', 'registered', 'promote', 'recover-promotion', 'rollback'
    ].map((mode) => [mode, cellId])),
    ...['inspect', 'verify', 'register', 'registered', 'promote', 'recover-promotion', 'rollback']
      .map((mode) => [mode, 'production-gce-c34']),
    ['inspect', 'production-gce-c27,production-gce-c28,production-gce-c29,production-gce-c30,production-gce-c31,production-gce-c32,production-gce-c33,production-gce-c34']
  ]
  for (const [mode, cellIds] of accepted) {
    assert.deepEqual(
      parseRelayAsiaAdmissionArguments(admissionArguments('production', mode, cellIds)).cells,
      cellIds.split(','),
      `${mode} ${cellIds}`
    )
  }
  const rejected = [
    ['initialize', 'production-gce-c30'],
    ['initialize', 'production-gce-c27,production-gce-c28,production-gce-c29,production-gce-c30,production-gce-c31'],
    ['register', 'production-gce-c27,production-gce-c28,production-gce-c29,production-gce-c30,production-gce-c31'],
    ['register', 'production-gce-c30,production-gce-c31'],
    ['register', 'production-gce-c29,production-gce-c30'],
    ['registered', 'production-gce-c27,production-gce-c28,production-gce-c29,production-gce-c30,production-gce-c31'],
    ['inspect', 'production-gce-c27,production-gce-c28,production-gce-c29,production-gce-c30'],
    ['inspect', 'production-gce-c27,production-gce-c28,production-gce-c29,production-gce-c30,production-gce-c31'],
    ['initialize', 'production-gce-c32'],
    ['register', 'production-gce-c32,production-gce-c33'],
    ['register', 'production-gce-c31,production-gce-c32'],
    ['promote', 'production-gce-c32,production-gce-c33'],
    ['rollback', 'production-gce-c32,production-gce-c33'],
    ['rollback', 'production-gce-c27,production-gce-c28,production-gce-c29,production-gce-c30,production-gce-c31'],
    ['verify', 'production-gce-c30,production-gce-c31'],
    ['verify', 'production-gce-c27,production-gce-c30'],
    ['promote', 'production-gce-c27,production-gce-c30'],
    ['promote', 'production-gce-c28,production-gce-c29,production-gce-c30'],
    ['promote', 'production-gce-c30,production-gce-c31'],
    ['promote', 'production-gce-c33,production-gce-c34'],
    ['promote', 'production-gce-c31,production-gce-c34'],
    ['register', 'production-gce-c33,production-gce-c34'],
    ['inspect', 'production-gce-c27,production-gce-c28,production-gce-c29,production-gce-c30,production-gce-c31,production-gce-c32,production-gce-c33'],
    ['rollback', 'production-gce-c27,production-gce-c28,production-gce-c29,production-gce-c30,production-gce-c31,production-gce-c32,production-gce-c33'],
    ['rollback', 'production-gce-c27,production-gce-c30'],
    ['rollback', 'production-gce-c30,production-gce-c31'],
    ['rollback', 'production-gce-c27,production-gce-c28,production-gce-c29,production-gce-c30'],
    ['rollback', 'production-gce-c28,production-gce-c29,production-gce-c30'],
    ['rollback', 'production-gce-c29'],
    ['register', 'staging-gce-c4']
  ]
  for (const [mode, cellIds] of rejected) {
    assert.throws(
      () => parseRelayAsiaAdmissionArguments(admissionArguments('production', mode, cellIds)),
      /--cell-ids/,
      `${mode} ${cellIds}`
    )
  }
  assert.deepEqual(
    parseRelayAsiaAdmissionArguments(admissionArguments('staging', 'promote', 'staging-gce-c4')).cells,
    ['staging-gce-c4']
  )
  assert.throws(
    () => parseRelayAsiaAdmissionArguments(admissionArguments('staging', 'promote', 'production-gce-c30')),
    /--cell-ids are invalid/
  )
})

test('registers C30 alone beside the general launch cells', async () => {
  const subject = harness({
    generation: 9,
    membership: { existingOnly: [], migrationOnly: [], general: [...launchCells] }
  })
  const result = await operateRelayAsiaAdmission({
    environment: 'production', mode: 'register', cells: ['production-gce-c30'],
    expectedGeneration: 9, imageDigest: digest, attemptId: 'asia_register_c30', token: 'not-logged'
  }, subject)
  const request = subject.requests.find(({ path }) => path.endsWith('/add-migration-cells'))
  assert.deepEqual(request.body.cells, [{
    cellId: 'production-gce-c30', cellUrl: 'https://c30.relay.onorca.dev', region: 'asia-east2',
    capacityRequests: 6_000, connectionHardCap: 3_000, connectionUnobservedBound: 60
  }])
  assert.deepEqual(result.states, { 'production-gce-c30': 'migration-only' })
  assert.deepEqual(subject.selector().membership.general, launchCells)
})

test('registers C31 alone beside the general C27-C30', async () => {
  const general = [...launchCells, 'production-gce-c30']
  const subject = harness({
    generation: 11,
    membership: { existingOnly: [], migrationOnly: [], general: [...general] }
  })
  const result = await operateRelayAsiaAdmission({
    environment: 'production', mode: 'register', cells: ['production-gce-c31'],
    expectedGeneration: 11, imageDigest: digest, attemptId: 'asia_register_c31', token: 'not-logged'
  }, subject)
  const request = subject.requests.find(({ path }) => path.endsWith('/add-migration-cells'))
  assert.deepEqual(request.body.cells, [{
    cellId: 'production-gce-c31', cellUrl: 'https://c31.relay.onorca.dev', region: 'asia-east2',
    capacityRequests: 6_000, connectionHardCap: 3_000, connectionUnobservedBound: 60
  }])
  assert.deepEqual(result.states, { 'production-gce-c31': 'migration-only' })
  assert.deepEqual(subject.selector().membership.general, general)
})

test('registers the C34 spare alone as migration-only in asia-east2', async () => {
  const general = [...launchCells, 'production-gce-c30', 'production-gce-c31']
  const subject = harness({
    generation: 17,
    membership: {
      existingOnly: [],
      migrationOnly: [],
      general: [...general, 'production-gce-c32', 'production-gce-c33']
    }
  })
  const result = await operateRelayAsiaAdmission({
    environment: 'production', mode: 'register', cells: ['production-gce-c34'],
    expectedGeneration: 17, imageDigest: digest, attemptId: 'asia_register_c34', token: 'not-logged'
  }, subject)
  const request = subject.requests.find(({ path }) => path.endsWith('/add-migration-cells'))
  assert.deepEqual(request.body.cells, [{
    cellId: 'production-gce-c34', cellUrl: 'https://c34.relay.onorca.dev', region: 'asia-east2',
    capacityRequests: 6_000, connectionHardCap: 3_000, connectionUnobservedBound: 60
  }])
  assert.deepEqual(result.states, { 'production-gce-c34': 'migration-only' })
  assert.equal(subject.selector().membership.general.includes('production-gce-c34'), false)
})
