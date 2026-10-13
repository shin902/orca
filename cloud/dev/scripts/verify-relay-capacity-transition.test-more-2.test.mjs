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

test('offline rollback rejects a reachable cell or durable work', async () => {
  const offlineConfig = {
    ...config,
    heartbeat: 'stale',
    admission: 'migration-only',
    draining: 'either',
    activity: 'restart-safe',
    runtime: 'unavailable',
    expectedImageDigests: [],
    hardCap: undefined,
    unobservedBound: undefined,
    timeoutMs: 0
  }
  await assert.rejects(
    verifyCapacityTransition(offlineConfig, {
      fetch: harness({ heartbeatFresh: false, admission: 'migration-only' }),
      token: 'masked-token'
    }),
    /timed out/
  )
  const active = harness({
    heartbeatFresh: false,
    admission: 'migration-only',
    activityLeases: 1
  })
  await assert.rejects(
    verifyCapacityTransition(offlineConfig, {
      fetch: async (url, options) =>
        new URL(url).pathname === '/v1/admin/runtime-status'
          ? Response.json({ error: 'backend_unavailable' }, { status: 503 })
          : await active(url, options),
      token: 'masked-token'
    }),
    /timed out/
  )
  await assert.rejects(
    verifyCapacityTransition(offlineConfig, {
      fetch: async (url, options) => {
        if (new URL(url).pathname === '/v1/admin/runtime-status') {
          return Response.json({ error: 'backend_unavailable' }, { status: 503 })
        }
        const result = await active(url, options)
        if (new URL(url).pathname !== '/v1/admin/cell-status') {return result}
        const body = await result.json()
        body.status.cellId = 'production-gce-other'
        return response(body)
      },
      token: 'masked-token'
    }),
    /does not match the cell/
  )
})

test('offline rollback arguments cannot claim live capacity', () => {
  assert.throws(
    () => parseCapacityTransitionArguments([
      '--director-origin', 'https://relay.example.com',
      '--cell-origin', 'https://c3.relay.example.com',
      '--cell-id', 'staging-gce-c3',
      '--heartbeat', 'stale',
      '--admission', 'migration-only',
      '--draining', 'either',
      '--activity', 'restart-safe',
      '--runtime', 'unavailable',
      '--hard-cap', '600',
      '--unobserved-bound', '60'
    ]),
    /cannot prove live capacity/
  )
})

test('accepts a quiescent matching cell without exposing assignments', async () => {
  assert.deepEqual(
    await verifyCapacityTransition(config, {
      fetch: harness(),
      token: 'masked-token'
    }),
    {
      cellId: config.cellId,
      admissionState: 'migration-only',
      assignments: 900,
      hardCap: 1_000,
      unobservedBound: 60,
      heartbeatFresh: true,
      imageDigest
    }
  )
})

test('migration-only admission rejects the irreversible existing-only state', async () => {
  const migrationConfig = { ...config, admission: 'migration-only' }
  await verifyCapacityTransition(migrationConfig, {
    fetch: harness({ admission: 'migration-only' }),
    token: 'masked-token'
  })
  await assert.rejects(
    verifyCapacityTransition(migrationConfig, {
      fetch: harness({ admission: 'existing-only' }),
      token: 'masked-token'
    }),
    /admission does not match/
  )
})

test('requires the exact runtime image and both cell origins', async () => {
  await assert.rejects(
    verifyCapacityTransition(config, {
      fetch: harness({ runtimeImageDigest: `sha256:${'b'.repeat(64)}` }),
      token: 'masked-token'
    }),
    /runtime does not match the cell/
  )
  const base = harness()
  for (const location of ['runtime', 'director']) {
    await assert.rejects(
      verifyCapacityTransition(config, {
        fetch: async (url, options) => {
          const result = await base(url, options)
          const path = new URL(url).pathname
          if (
            (location === 'runtime' && path !== '/v1/admin/runtime-status') ||
            (location === 'director' && path !== '/v1/admin/cell-status')
          ) {return result}
          const body = await result.json()
          if (location === 'runtime') {body.cellUrl = 'https://other.example.com'}
          else {body.status.cellUrl = 'https://other.example.com'}
          return response(body)
        },
        token: 'masked-token'
      }),
      /does not match the cell/
    )
  }
})

test('accepts a quiescent legacy runtime before its first cap transition', async () => {
  assert.equal(
    (
      await verifyCapacityTransition(
        { ...config, hardCap: undefined, unobservedBound: undefined, heartbeat: 'either' },
        { fetch: harness({ legacy: true }), token: 'masked-token' }
      )
    ).cellId,
    config.cellId
  )
})

test('uses the legacy runtime heartbeat when capacity telemetry is not registered', async () => {
  const result = await verifyCapacityTransition(
    {
      ...config,
      hardCap: undefined,
      unobservedBound: undefined,
      heartbeat: 'fresh',
      draining: 'forbidden',
      activity: 'allowed'
    },
    { fetch: harness({ legacy: true, draining: 'forbidden' }), token: 'masked-token' }
  )
  assert.equal(result.heartbeatFresh, true)
})

test('rejects old directors and active cells', async () => {
  await assert.rejects(
    verifyCapacityTransition(config, { fetch: harness({ protocol: 1 }), token: 'masked' }),
    /not capacity-protocol compatible/
  )
  let now = 0
  await assert.rejects(
    verifyCapacityTransition(config, {
      fetch: harness({ active: 1 }),
      token: 'masked',
      now: () => now,
      wait: async (milliseconds) => {
        now += milliseconds
      }
    }),
    /timed out/
  )
})

test('accepts active controls only when the transition explicitly allows them', async () => {
  const activeConfig = {
    ...config,
    admission: 'general',
    draining: 'forbidden',
    activity: 'allowed'
  }
  const result = await verifyCapacityTransition(activeConfig, {
    fetch: harness({ active: 900, admission: 'general', draining: 'forbidden' }),
    token: 'masked'
  })
  assert.equal(result.admissionState, 'general')
})

test('accepts only rejected reconnect traffic at the restart gate', async () => {
  const restartConfig = {
    ...config,
    admission: 'migration-only',
    activity: 'restart-safe',
    timeoutMs: 10_000
  }
  const reconnecting = harness({
    active: 10,
    activityLeases: 839,
    restartBlockingActivityLeases: 0,
    restartBlockingActivityRequestUnits: 0,
    restartBlockingReservedRequests: 0,
    pendingControlReservations: 839
  })
  let now = 0
  let runtimeReads = 0
  const fetch = async (url, options) => {
    if (new URL(url).pathname === '/v1/admin/runtime-status') {runtimeReads += 1}
    return await reconnecting(url, options)
  }
  assert.equal((await verifyCapacityTransition(restartConfig, {
    fetch,
    token: 'masked-token',
    now: () => now,
    wait: async (milliseconds) => {
      now += milliseconds
    }
  })).cellId, config.cellId)
  assert.equal(runtimeReads, 2)
  await assert.rejects(
    verifyCapacityTransition({ ...config, timeoutMs: 0 }, {
      fetch: reconnecting,
      token: 'masked-token'
    }),
    /timed out/
  )
})
