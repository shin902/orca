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

test('parses a paired reviewed capacity', () => {
  assert.deepEqual(
    parseCapacityTransitionArguments([
      '--director-origin', 'https://relay.example.com',
      '--cell-origin', 'https://c3.relay.example.com',
      '--cell-id', 'staging-gce-c3',
      '--heartbeat', 'stale',
      '--admission', 'migration-only',
      '--draining', 'required',
      '--activity', 'restart-safe',
      '--expected-image-digests', imageDigest,
      '--hard-cap', '1000',
      '--unobserved-bound', '60',
      '--pace-window-ms', '300000'
    ]),
    {
      ...config,
      heartbeat: 'stale',
      admission: 'migration-only',
      activity: 'restart-safe',
      runtime: 'required',
      expectedImageDigests: [imageDigest],
      paceWindowMs: 300_000,
      timeoutMs: 180_000
    }
  )
})

test('accepts either exact predecessor image without weakening the live state checks', async () => {
  const predecessor = `sha256:${'b'.repeat(64)}`
  const compatible = `sha256:${'c'.repeat(64)}`
  const predecessorConfig = parseCapacityTransitionArguments([
    '--director-origin', 'https://relay.example.com',
    '--cell-origin', 'https://c3.relay.example.com',
    '--cell-id', 'staging-gce-c3',
    '--heartbeat', 'fresh',
    '--admission', 'general',
    '--draining', 'forbidden',
    '--activity', 'allowed',
    '--expected-image-digests', `${predecessor},${compatible}`,
    '--hard-cap', '600',
    '--unobserved-bound', '60'
  ])
  assert.deepEqual(predecessorConfig.expectedImageDigests, [predecessor, compatible])
  assert.deepEqual(
    {
      heartbeat: predecessorConfig.heartbeat,
      admission: predecessorConfig.admission,
      draining: predecessorConfig.draining,
      hardCap: predecessorConfig.hardCap,
      unobservedBound: predecessorConfig.unobservedBound
    },
    {
      heartbeat: 'fresh',
      admission: 'general',
      draining: 'forbidden',
      hardCap: 600,
      unobservedBound: 60
    }
  )
  const liveState = {
    runtimeHardCap: 600,
    directorHardCap: 600,
    runtimeImageDigest: compatible,
    admission: 'general',
    draining: 'forbidden'
  }
  assert.equal(
    (await verifyCapacityTransition(predecessorConfig, {
      fetch: harness(liveState),
      token: 'masked-token'
    })).imageDigest,
    compatible
  )
  await assert.rejects(
    verifyCapacityTransition(predecessorConfig, {
      fetch: harness({
        ...liveState,
        runtimeImageDigest: `sha256:${'d'.repeat(64)}`
      }),
      token: 'masked-token'
    }),
    /runtime does not match the cell/
  )
})

test('requires the exact regional rehome protocol when requested', async () => {
  const rehomeConfig = {
    ...config,
    regionalRehomeProtocol: 1
  }
  await verifyCapacityTransition(rehomeConfig, {
    token: 'token',
    fetch: harness({ regionalRehomeProtocol: 1 })
  })
  await assert.rejects(
    verifyCapacityTransition(rehomeConfig, {
      token: 'token',
      fetch: harness({ regionalRehomeProtocol: 0 }),
      now: () => 1,
      wait: async () => undefined
    }),
    /runtime does not match/
  )
  assert.equal(
    parseCapacityTransitionArguments([
      '--director-origin', 'https://relay.example.com',
      '--cell-origin', 'https://c3.relay.example.com',
      '--cell-id', 'staging-gce-c3',
      '--heartbeat', 'fresh',
      '--admission', 'general',
      '--draining', 'forbidden',
      '--activity', 'allowed',
      '--regional-rehome-protocol', '1'
    ]).regionalRehomeProtocol,
    1
  )
})

test('binds an absent rehome protocol to 0 for legacy pre-rehome images', async () => {
  // A rolled-back cell runs an image that omits the field entirely; the
  // documented contract binds absence to protocol 0.
  await verifyCapacityTransition(
    { ...config, regionalRehomeProtocol: 0 },
    { token: 'token', fetch: harness({ regionalRehomeProtocol: null }) }
  )
  await verifyCapacityTransition(
    { ...config, regionalRehomeProtocol: 0 },
    { token: 'token', fetch: harness({ regionalRehomeProtocol: 0 }) }
  )
  await assert.rejects(
    verifyCapacityTransition(
      { ...config, regionalRehomeProtocol: 1 },
      {
        token: 'token',
        fetch: harness({ regionalRehomeProtocol: null }),
        now: () => 1,
        wait: async () => undefined
      }
    ),
    /runtime does not match/
  )
})

test('restart-safe mode requires the exact isolated drain state', () => {
  assert.throws(
    () => parseCapacityTransitionArguments([
      '--director-origin', 'https://relay.example.com',
      '--cell-origin', 'https://c3.relay.example.com',
      '--cell-id', 'staging-gce-c3',
      '--heartbeat', 'either',
      '--admission', 'general',
      '--draining', 'required',
      '--activity', 'restart-safe'
    ]),
    /requires migration-only admission and draining/
  )
})

test('offline rollback requires two stale zero-durable-activity samples', async () => {
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
    timeoutMs: 10_000
  }
  const base = harness({
    heartbeatFresh: false,
    admission: 'migration-only',
    draining: 'forbidden',
    activityLeases: 0,
    activityRequestUnits: 0,
    reservedRequests: 0,
    restartBlockingActivityLeases: 0,
    restartBlockingActivityRequestUnits: 0,
    restartBlockingReservedRequests: -1
  })
  let runtimeReads = 0
  let directorReads = 0
  let now = 0
  const result = await verifyCapacityTransition(offlineConfig, {
    fetch: async (url, options) => {
      const pathname = new URL(url).pathname
      if (pathname === '/v1/admin/runtime-status') {
        runtimeReads += 1
        return Response.json({ error: 'backend_unavailable' }, { status: 503 })
      }
      if (pathname === '/v1/admin/cell-status') {directorReads += 1}
      return await base(url, options)
    },
    token: 'masked-token',
    now: () => now,
    wait: async (milliseconds) => {
      now += milliseconds
    }
  })
  assert.equal(result.cellId, config.cellId)
  assert.equal(result.hardCap, null)
  assert.equal(result.restartBlockingReservedRequests, -1)
  assert.equal(runtimeReads, 2)
  assert.equal(directorReads, 2)
})
