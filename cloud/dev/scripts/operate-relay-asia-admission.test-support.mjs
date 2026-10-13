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



export const digest = `sha256:${'a'.repeat(64)}`
export const membershipDigest = (membership) =>
  createHash('sha256').update(JSON.stringify(membership)).digest('hex')

export function harness(initialSelector, runtimeDigests = {}, runtimeRegions = {}) {
  const initialMembership = structuredClone(initialSelector.membership)
  let selector = structuredClone(initialSelector)
  const intents = new Map()
  const requests = []
  let fetches = 0
  let failAfterIntent = false
  const post = async (url, body) => {
    const parsed = new URL(url)
    requests.push({ path: parsed.pathname, body })
    if (parsed.pathname === '/v1/admin/runtime-status') {
      const cell = parsed.hostname.split('.')[0]
      return {
        cellId: `production-gce-${cell}`,
        cellUrl: parsed.origin,
        region: runtimeRegions[`production-gce-${cell}`] ?? 'asia-east2',
        imageDigest: runtimeDigests[`production-gce-${cell}`] ?? digest,
        draining: false,
        connectionCapacity: { hardCap: 3_000, unobservedBound: 60 }
      }
    }
    if (parsed.pathname === '/v1/admin/cell-status') {
      return {
        status: {
          cellUrl: `https://${body.cellId.split('-').at(-1)}.relay.onorca.dev`,
          runtime: { heartbeatFresh: true, ready: true }
        }
      }
    }
    if (parsed.pathname.endsWith('/status')) {
      return { selector, intent: body.attemptId ? intents.get(body.attemptId) ?? null : null }
    }
    if (parsed.pathname.endsWith('/add-migration-cells')) {
      selector = {
        generation: selector.generation + 1,
        attemptId: body.attemptId,
        membership: {
          ...selector.membership,
          migrationOnly: [...selector.membership.migrationOnly, ...body.cells.map((cell) => cell.cellId)].sort()
        }
      }
    } else if (parsed.pathname.endsWith('/apply-staging-asia-proof')) {
      const membership = structuredClone(selector.membership)
      membership.migrationOnly = membership.migrationOnly.filter((cell) => cell !== 'staging-gce-c4')
      membership.general = membership.general.filter((cell) => cell !== 'staging-gce-c4')
      membership[body.state === 'general' ? 'general' : 'migrationOnly'].push('staging-gce-c4')
      selector = { generation: selector.generation + 1, attemptId: body.attemptId, membership }
    } else if (parsed.pathname.endsWith('/apply')) {
      if (
        body.expectedMembershipSha256 &&
        body.expectedMembershipSha256 !== membershipDigest(selector.membership)
      ) {throw new Error('admission_selector_membership_mismatch')}
      if (failAfterIntent) {
        failAfterIntent = false
        intents.set(body.attemptId, {
          state: 'unchanged',
          expectedGeneration: body.expectedGeneration,
          previousMembership: structuredClone(selector.membership),
          membership: structuredClone(body.membership)
        })
        throw new Error('failure after intent persistence')
      }
      selector = { generation: selector.generation + 1, attemptId: body.attemptId, membership: body.membership }
    } else {throw new Error(`unexpected ${parsed.pathname}`)}
    intents.set(body.attemptId, {
      state: 'committed', expectedGeneration: body.expectedGeneration,
      previousMembership: initialSelector.membership,
      membership: selector.membership
    })
    return { changed: true, selector }
  }
  const fetch = async () => {
    fetches++
    return new Response(null, { status: 200 })
  }
  const commitWithoutResponse = async (path, body) => {
    await post(`https://relay.onorca.dev${path}`, body)
    throw new Error('response lost after commit')
  }
  return {
    post, fetch, requests, commitWithoutResponse,
    failNextApplyAfterIntent: () => (failAfterIntent = true),
    apply: async (attemptId, membership) => await post(
      'https://relay.onorca.dev/v1/admin/admission-selector/apply',
      { attemptId, expectedGeneration: selector.generation, membership }
    ),
    fetchCount: () => fetches, selector: () => selector
  }
}

export const baseSelector = {
  generation: 7,
  membership: { existingOnly: [], migrationOnly: [], general: ['production-gce-c26'] }
}


export const launchCells = ['production-gce-c27', 'production-gce-c28', 'production-gce-c29']

export function admissionArguments(environment, mode, cellIds) {
  return [
    '--environment', environment, '--mode', mode, '--cell-ids', cellIds,
    '--image-digest', digest, '--expected-generation', '9', '--attempt-id', 'asia_wave_9'
  ]
}
