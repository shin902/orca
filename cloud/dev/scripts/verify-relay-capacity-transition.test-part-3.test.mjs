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
import { strandedCell, pacedRestartConfig, fakeClock } from './verify-relay-capacity-transition.test-support.mjs'

test('restart-safe fails on live runtime work or an open migration regardless of leases', async (t) => {
  for (const blocker of [
    { controls: 1 },
    { splices: 1 },
    { pendingSplices: 1 },
    { queuedBytes: 1 },
    { outgoingMigrations: 1 },
    { incomingMigrations: 1 }
  ]) {
    await t.test(Object.keys(blocker)[0], async () => {
      await assert.rejects(
        verifyCapacityTransition(pacedRestartConfig, {
          fetch: harness({ ...strandedCell, ...blocker }),
          token: 'masked-token',
          progress: () => {},
          ...fakeClock()
        }),
        /timed out.*"restartSafeSamples":0/
      )
    })
  }
})

test('unauthenticated redials do not reset the pace window', async () => {
  let runtimeReads = 0
  const lines = []
  const result = await verifyCapacityTransition(pacedRestartConfig, {
    fetch: async (url, options) => {
      if (new URL(url).pathname === '/v1/admin/runtime-status') {runtimeReads += 1}
      return await harness({
        ...strandedCell,
        active: runtimeReads % 4,
        enforcedConnectionUnits: 0,
        preAuthConnections: runtimeReads % 2
      })(url, options)
    },
    token: 'masked-token',
    progress: (line) => lines.push(line),
    ...fakeClock()
  })
  assert.equal(runtimeReads, 61)
  assert.equal(result.stranded.restartBlockingActivityLeases, 4)
  assert.deepEqual(
    lines.slice(0, 4).map((line) => [line.totalConnections, line.preAuthConnections]),
    [[1, 1], [2, 0], [3, 1], [0, 0]]
  )
})

// c29 2026-10-01: a phone redialling the drained cell holds one physical socket and one
// reserved host-data unit until the cell refuses it; a host control redial holds an in-flight unit.
const refusedPhoneDial = {
  active: 1,
  preAuthConnections: 1,
  reservedConnectionUnits: 1,
  enforcedConnectionUnits: 2
}
const refusedControlDial = { inFlightConnections: 1, enforcedConnectionUnits: 1 }

test('a draining cell reaches the pace window through refused redials', async () => {
  let runtimeReads = 0
  const lines = []
  const result = await verifyCapacityTransition(pacedRestartConfig, {
    fetch: async (url, options) => {
      if (new URL(url).pathname === '/v1/admin/runtime-status') {runtimeReads += 1}
      const redial = runtimeReads % 3 === 0
        ? refusedPhoneDial
        : runtimeReads % 3 === 1 ? refusedControlDial : {}
      return await harness({ ...strandedCell, ...redial })(url, options)
    },
    token: 'masked-token',
    progress: (line) => lines.push(line),
    ...fakeClock()
  })
  assert.equal(runtimeReads, 61)
  assert.equal(result.cellId, config.cellId)
  assert.deepEqual(lines.slice(0, 3).map((line) => line.restartSafeSamples), [1, 2, 3])
})

test('a refused redial cannot hide a persistent control on a draining cell', async () => {
  let runtimeReads = 0
  const lines = []
  await assert.rejects(
    verifyCapacityTransition(pacedRestartConfig, {
      fetch: async (url, options) => {
        if (new URL(url).pathname === '/v1/admin/runtime-status') {runtimeReads += 1}
        const redial = runtimeReads % 2 === 0 ? refusedPhoneDial : {}
        return await harness({ ...strandedCell, ...redial, controls: 1 })(url, options)
      },
      token: 'masked-token',
      progress: (line) => lines.push(line),
      ...fakeClock()
    }),
    /timed out.*"restartSafeSamples":0/
  )
  assert.ok(lines.length > 61)
  assert.ok(lines.every((line) => line.restartSafeSamples === 0 && line.runtime.controls === 1))
})

test('a runtime that is not draining never passes restart-safe', async (t) => {
  for (const [name, state] of [
    ['idle', {}],
    ['refused phone dial', refusedPhoneDial],
    ['refused control dial', refusedControlDial]
  ]) {
    await t.test(name, async () => {
      await assert.rejects(
        verifyCapacityTransition(pacedRestartConfig, {
          fetch: harness({ ...strandedCell, ...state, draining: 'forbidden' }),
          token: 'masked-token',
          progress: () => {},
          ...fakeClock()
        }),
        /timed out.*"draining":false.*"restartSafeSamples":0/
      )
    })
  }
})

test('quiescent transitions still reject refused redials', async (t) => {
  for (const [name, state] of [
    ['refused phone dial', refusedPhoneDial],
    ['refused control dial', refusedControlDial]
  ]) {
    await t.test(name, async () => {
      await assert.rejects(
        verifyCapacityTransition(config, { fetch: harness(state), token: 'masked-token' }),
        /timed out/
      )
    })
  }
})

test('restart progress prints every counter the gate reads', async () => {
  const lines = []
  await assert.rejects(
    verifyCapacityTransition(
      { ...pacedRestartConfig, timeoutMs: 0 },
      {
        fetch: harness({
          ...strandedCell,
          active: 7,
          preAuthConnections: 1,
          inFlightConnections: 2,
          reservedConnectionUnits: 3,
          enforcedConnectionUnits: 12,
          controls: 4,
          splices: 5,
          pendingSplices: 6,
          queuedBytes: 8,
          incomingMigrations: 9,
          outgoingMigrations: 10
        }),
        token: 'masked-token',
        progress: (line) => lines.push(line),
        ...fakeClock()
      }
    ),
    /timed out/
  )
  assert.equal(lines.length, 1)
  assert.deepEqual(lines[0], {
    event: 'relay_capacity_transition_restart_progress',
    restartSafeSamples: 0,
    requiredRestartSafeSamples: 61,
    totalConnections: 7,
    preAuthConnections: 1,
    runtimeAvailable: true,
    admissionState: 'migration-only',
    draining: true,
    runtime: {
      totalConnections: 7,
      preAuthConnections: 1,
      inFlightConnections: 2,
      reservedConnectionUnits: 3,
      enforcedConnectionUnits: 12,
      controls: 4,
      splices: 5,
      pendingSplices: 6,
      queuedBytes: 8
    },
    directorHeartbeatFresh: true,
    stranded: {
      restartBlockingActivityLeases: 4,
      restartBlockingActivityRequestUnits: 4,
      restartBlockingReservedRequests: -2,
      outgoingMigrations: 10,
      incomingMigrations: 9
    }
  })
})

test('a draining cell still fails closed on malformed handshake counters', async (t) => {
  for (const [name, state] of [
    ['negative in-flight', { inFlightConnections: -1 }],
    ['fractional reserved', { reservedConnectionUnits: 0.5 }],
    ['non-numeric reserved', { reservedConnectionUnits: 'unknown' }]
  ]) {
    await t.test(name, async () => {
      await assert.rejects(
        verifyCapacityTransition(pacedRestartConfig, {
          fetch: harness({ ...strandedCell, ...state }),
          token: 'masked-token',
          progress: () => {},
          ...fakeClock()
        }),
        /live runtime count is invalid/
      )
    })
  }
})
