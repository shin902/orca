import assert from 'node:assert/strict'

import { test } from 'node:test'

import {
  parseCapacityTransitionArguments,
  verifyCapacityTransition
} from './verify-relay-capacity-transition.mjs'


import {
  imageDigest,
  config,
  response,
  harness
} from './verify-relay-capacity-transition.test-support.mjs'

test('restart-safe settling resets after data-plane admission appears', async () => {
  const restartConfig = {
    ...config,
    admission: 'migration-only',
    activity: 'restart-safe',
    timeoutMs: 20_000
  }
  const safe = harness({ active: 1, activityLeases: 0 })
  const unsafe = harness({ active: 1, activityLeases: 0, controls: 1 })
  let runtimeReads = 0
  let now = 0
  const result = await verifyCapacityTransition(restartConfig, {
    fetch: async (url, options) => {
      if (new URL(url).pathname !== '/v1/admin/runtime-status') {
        return await safe(url, options)
      }
      runtimeReads += 1
      return await (runtimeReads === 2 ? unsafe : safe)(url, options)
    },
    token: 'masked-token',
    now: () => now,
    wait: async (milliseconds) => {
      now += milliseconds
    }
  })
  assert.equal(result.cellId, config.cellId)
  assert.equal(runtimeReads, 4)
})

test('restart-safe settling resets after a migration opens', async () => {
  const restartConfig = {
    ...config,
    admission: 'migration-only',
    activity: 'restart-safe',
    timeoutMs: 20_000
  }
  const safe = harness({
    activityLeases: 839,
    restartBlockingActivityLeases: 0,
    restartBlockingActivityRequestUnits: 0,
    restartBlockingReservedRequests: 0
  })
  const unsafe = harness({
    activityLeases: 839,
    restartBlockingActivityLeases: 0,
    restartBlockingActivityRequestUnits: 0,
    restartBlockingReservedRequests: 0,
    incomingMigrations: 1
  })
  let directorReads = 0
  let runtimeReads = 0
  let now = 0
  const result = await verifyCapacityTransition(restartConfig, {
    fetch: async (url, options) => {
      if (new URL(url).pathname === '/v1/admin/runtime-status') {runtimeReads += 1}
      if (new URL(url).pathname !== '/v1/admin/cell-status') {
        return await safe(url, options)
      }
      directorReads += 1
      return await (directorReads === 2 ? unsafe : safe)(url, options)
    },
    token: 'masked-token',
    now: () => now,
    wait: async (milliseconds) => {
      now += milliseconds
    }
  })
  assert.equal(result.cellId, config.cellId)
  assert.equal(runtimeReads, 4)
})

test('restart gate rejects malformed restart aggregates', async (t) => {
  const restartConfig = {
    ...config,
    admission: 'migration-only',
    activity: 'restart-safe',
    timeoutMs: 0
  }
  for (const field of [
    'restartBlockingActivityLeases',
    'restartBlockingActivityRequestUnits'
  ]) {
    for (const value of [undefined, -1]) {
      await t.test(`${field} ${value === undefined ? 'missing' : 'negative'}`, async () => {
        const base = harness({ [field]: value })
        const fetch = value === undefined
          ? async (url, options) => {
              const result = await base(url, options)
              if (new URL(url).pathname !== '/v1/admin/cell-status') {return result}
              const body = await result.json()
              delete body.status[field]
              return response(body)
            }
          : base
        await assert.rejects(
          verifyCapacityTransition(restartConfig, {
            fetch,
            token: 'masked-token'
          }),
          /is invalid/
        )
      })
    }
  }
  for (const value of [undefined, null, '0', false]) {
    await t.test(`restartBlockingReservedRequests ${String(value)}`, async () => {
      const base = harness({
        preAuthConnections: 1,
        restartBlockingActivityLeases: 1,
        restartBlockingReservedRequests: value
      })
      await assert.rejects(
        verifyCapacityTransition(restartConfig, {
          fetch: async (url, options) => {
            const result = await base(url, options)
            if (
              value !== undefined ||
              new URL(url).pathname !== '/v1/admin/cell-status'
            ) {return result}
            const body = await result.json()
            delete body.status.restartBlockingReservedRequests
            return response(body)
          },
          token: 'masked-token'
        }),
        /is invalid/
      )
    })
  }
})
