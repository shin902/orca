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

test('offline rollback validates restart reservation accounting before other blockers', async (t) => {
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
  for (const value of [undefined, null, '0', false]) {
    await t.test(String(value), async () => {
      const base = harness({
        heartbeatFresh: false,
        activityLeases: 1,
        restartBlockingReservedRequests: value
      })
      await assert.rejects(
        verifyCapacityTransition(offlineConfig, {
          fetch: async (url, options) => {
            const pathname = new URL(url).pathname
            if (pathname === '/v1/admin/runtime-status') {
              return Response.json({ error: 'backend_unavailable' }, { status: 503 })
            }
            const result = await base(url, options)
            if (value !== undefined || pathname !== '/v1/admin/cell-status') {return result}
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

test('negative restart reservation accounting is safe and remains observable', async () => {
  const result = await verifyCapacityTransition(
    {
      ...config,
      admission: 'migration-only',
      activity: 'restart-safe',
      timeoutMs: 10_000
    },
    {
      fetch: harness({ restartBlockingReservedRequests: -1 }),
      token: 'masked-token',
      now: () => 0,
      wait: async () => undefined
    }
  )
  assert.equal(result.restartBlockingReservedRequests, -1)
})

test('negative restart reservation accounting cannot mask real work', async () => {
  await assert.rejects(
    verifyCapacityTransition(
      {
        ...config,
        admission: 'migration-only',
        activity: 'restart-safe',
        timeoutMs: 0
      },
      {
        fetch: harness({
          controls: 1,
          restartBlockingReservedRequests: -1
        }),
        token: 'masked-token'
      }
    ),
    /"restartBlockingReservedRequests":-1/
  )
})

test('restart gate rejects live or durable cell work', async (t) => {
  const restartConfig = {
    ...config,
    admission: 'migration-only',
    activity: 'restart-safe',
    timeoutMs: 0
  }
  const unsafeStates = [
    ['control', { active: 1, activityLeases: 0, controls: 1 }],
    ['splice', { active: 1, activityLeases: 0, splices: 1 }],
    ['pending splice', { active: 1, activityLeases: 0, pendingSplices: 1 }],
    ['queued data', { active: 1, activityLeases: 0, queuedBytes: 1 }],
    ['control beside a reserved data unit', {
      active: 2,
      activityLeases: 0,
      controls: 1,
      reservedConnectionUnits: 1,
      enforcedConnectionUnits: 3
    }],
    ['outgoing migration', { outgoingMigrations: 1 }],
    ['incoming migration', { incomingMigrations: 1 }]
  ]
  for (const [name, state] of unsafeStates) {
    await t.test(name, async () => {
      await assert.rejects(
        verifyCapacityTransition(restartConfig, {
          fetch: harness(state),
          token: 'masked-token'
        }),
        // A zero timeout can never collect two samples; the blocker must stop the first one.
        /timed out.*"restartSafeSamples":0/
      )
    })
  }
})

test('restart timeout reports only aggregate blockers', async () => {
  const base = harness({
    controls: 2,
    restartBlockingActivityLeases: 3,
    restartBlockingActivityRequestUnits: 4,
    restartBlockingReservedRequests: 5,
    incomingMigrations: 6
  })
  await assert.rejects(
    verifyCapacityTransition(
      {
        ...config,
        admission: 'migration-only',
        draining: 'required',
        activity: 'restart-safe',
        timeoutMs: 0
      },
      { fetch: base, token: 'masked-token' }
    ),
    (error) => {
      assert.match(error.message, /"controls":2/)
      assert.match(error.message, /"restartBlockingActivityLeases":3/)
      assert.match(error.message, /"incomingMigrations":6/)
      assert.doesNotMatch(error.message, /user|host|secret|token/i)
      return true
    }
  )
})

test('restart timeout reports one of two safe settling samples', async () => {
  const base = harness()
  await assert.rejects(
    verifyCapacityTransition(
      {
        ...config,
        admission: 'migration-only',
        draining: 'required',
        activity: 'restart-safe',
        timeoutMs: 0
      },
      { fetch: base, token: 'masked-token' }
    ),
    (error) => {
      assert.match(error.message, /"restartSafeSamples":1/)
      assert.match(error.message, /"requiredRestartSafeSamples":2/)
      return true
    }
  )
})

test('quiescent timeout reports connection and capacity aggregates', async () => {
  const base = harness({
    active: 2,
    enforcedConnectionUnits: 3,
    activityLeases: 0,
    activityRequestUnits: 0,
    reservedRequests: 0,
    restartBlockingActivityLeases: 0,
    restartBlockingActivityRequestUnits: 0,
    restartBlockingReservedRequests: 0,
    pendingControlReservations: 4,
    heartbeatFresh: false
  })
  await assert.rejects(
    verifyCapacityTransition({ ...config, timeoutMs: 0 }, { fetch: base, token: 'masked-token' }),
    (error) => {
      assert.match(error.message, /"totalConnections":2/)
      assert.match(error.message, /"enforcedConnectionUnits":3/)
      assert.match(error.message, /"pendingControlReservations":4/)
      assert.match(error.message, /"heartbeatFresh":false/)
      return true
    }
  )
})

test('timeout distinguishes runtime and director capacity views', async () => {
  const base = harness({ runtimeHardCap: 999 })
  await assert.rejects(
    verifyCapacityTransition({ ...config, timeoutMs: 0 }, { fetch: base, token: 'masked-token' }),
    (error) => {
      assert.match(error.message, /"runtimeCapacity":\{"hardCap":999/)
      assert.match(error.message, /"directorCapacity":\{"hardCap":1000/)
      return true
    }
  )
})

test('offline timeout reports every durable activity aggregate', async () => {
  const base = harness({
    activityLeases: 1,
    activityRequestUnits: 2,
    reservedRequests: 3,
    pendingControlReservations: 4,
    heartbeatFresh: false
  })
  await assert.rejects(
    verifyCapacityTransition(
      {
        ...config,
        admission: 'migration-only',
        draining: 'either',
        activity: 'restart-safe',
        heartbeat: 'stale',
        runtime: 'unavailable',
        hardCap: undefined,
        unobservedBound: undefined,
        timeoutMs: 0
      },
      {
        fetch: async (url, options) =>
          new URL(url).pathname === '/v1/admin/runtime-status'
            ? Response.json({ error: 'backend_unavailable' }, { status: 503 })
            : await base(url, options),
        token: 'masked-token'
      }
    ),
    (error) => {
      assert.match(error.message, /"activityLeases":1/)
      assert.match(error.message, /"activityRequestUnits":2/)
      assert.match(error.message, /"reservedRequests":3/)
      assert.match(error.message, /"pendingControlReservations":4/)
      return true
    }
  )
})

test('waits for a drained runtime to become quiescent', async () => {
  let runtimeReads = 0
  const base = harness()
  const fetch = async (url, options) => {
    if (new URL(url).pathname === '/v1/admin/runtime-status' && runtimeReads++ === 0) {
      return Response.json({
        role: 'cell',
        cellId: config.cellId,
        cellUrl: config.cellOrigin,
        imageDigest,
        draining: true,
        connectionCapacity: {
          hardCap: 1_000,
          unobservedBound: 60,
          controlRebindReserve: 100,
          ordinaryConnectionLimit: 900,
          normalAdmissionPause: 840
        },
        runtime: { totalConnections: 1, preAuthConnections: 0, enforcedConnectionUnits: 1 }
      })
    }
    return await base(url, options)
  }
  let now = 0
  const result = await verifyCapacityTransition(
    { ...config, timeoutMs: 10_000 },
    {
      fetch,
      token: 'masked',
      now: () => now,
      wait: async (milliseconds) => {
        now += milliseconds
      }
    }
  )
  assert.equal(result.cellId, config.cellId)
  assert.equal(runtimeReads, 2)
})

test('waits for transient cell routing after a replacement becomes stable', async () => {
  for (const status of [502, 503, 504]) {
    let runtimeReads = 0
    let unavailableResponse
    const base = harness()
    const fetch = async (url, options) => {
      if (new URL(url).pathname === '/v1/admin/runtime-status' && runtimeReads++ === 0) {
        unavailableResponse = Response.json({ error: 'backend_unavailable' }, { status })
        return unavailableResponse
      }
      return await base(url, options)
    }
    let now = 0
    const result = await verifyCapacityTransition(
      { ...config, timeoutMs: 10_000 },
      {
        fetch,
        token: 'masked',
        now: () => now,
        wait: async (milliseconds) => {
          now += milliseconds
        }
      }
    )
    assert.equal(result.cellId, config.cellId)
    assert.equal(runtimeReads, 2)
    assert.equal(unavailableResponse.bodyUsed, true)
  }
})

test('persistent cell unavailability fails closed at the deadline', async () => {
  let runtimeReads = 0
  let directorStatusReads = 0
  let waits = 0
  let now = 0
  const base = harness()
  await assert.rejects(
    verifyCapacityTransition(
      { ...config, timeoutMs: 10_000 },
      {
        fetch: async (url, options) => {
          const pathname = new URL(url).pathname
          if (pathname === '/v1/admin/runtime-status') {
            runtimeReads += 1
            return Response.json({ error: 'backend_unavailable' }, { status: 503 })
          }
          if (pathname === '/v1/admin/cell-status') {directorStatusReads += 1}
          return await base(url, options)
        },
        token: 'masked',
        now: () => now,
        wait: async (milliseconds) => {
          waits += 1
          now += milliseconds
        }
      }
    ),
    /capacity transition verification timed out: \{"runtimeAvailable":false\}/
  )
  assert.equal(runtimeReads, 3)
  assert.equal(directorStatusReads, 0)
  assert.equal(waits, 2)
})

test('general-or-migration-only admits both recovery states and nothing else', async () => {
  for (const [admission, accepted] of [
    ['general', true],
    ['migration-only', true],
    ['existing-only', false]
  ]) {
    const attempt = verifyCapacityTransition(
      {
        ...config,
        admission: 'general-or-migration-only',
        draining: 'either',
        activity: 'allowed'
      },
      { fetch: harness({ admission, draining: 'either' }), token: 'masked' }
    )
    await (accepted ? attempt : assert.rejects(attempt, /admission does not match/))
  }
})

test('does not retry a rejected cell admin token', async () => {
  let waits = 0
  const base = harness()
  await assert.rejects(
    verifyCapacityTransition(config, {
      fetch: async (url, options) =>
        new URL(url).pathname === '/v1/admin/runtime-status'
          ? Response.json({ error: 'invalid_token' }, { status: 401 })
          : await base(url, options),
      token: 'masked',
      wait: async () => {
        waits += 1
      }
    }),
    /cell runtime status returned 401/
  )
  assert.equal(waits, 0)
})

test('retries a transient 503 on the director cell-status read', async () => {
  const base = harness()
  const statusCalls = []
  const result = await verifyCapacityTransition(config, {
    token: 'masked-token',
    wait: async () => {},
    fetch: async (url, options) => {
      const path = new URL(url).pathname
      if (path !== '/v1/admin/cell-status') {return await base(url, options)}
      statusCalls.push(path)
      if (statusCalls.length === 1) {return new Response('warming up', { status: 503 })}
      return await base(url, options)
    }
  })
  assert.equal(statusCalls.length, 2)
  assert.equal(result.cellId, config.cellId)
})

test('fails when both director cell-status attempts return a transient 503', async () => {
  const base = harness()
  let statusCalls = 0
  await assert.rejects(
    verifyCapacityTransition(config, {
      token: 'masked-token',
      wait: async () => {},
      fetch: async (url, options) => {
        const path = new URL(url).pathname
        if (path !== '/v1/admin/cell-status') {return await base(url, options)}
        statusCalls += 1
        return new Response('warming up', { status: 503 })
      }
    }),
    /cell status returned 503/
  )
  assert.equal(statusCalls, 2)
})

test('retries a transient 503 on the director health preflight', async () => {
  const base = harness()
  let healthCalls = 0
  const result = await verifyCapacityTransition(config, {
    token: 'masked-token',
    wait: async () => {},
    fetch: async (url, options) => {
      const path = new URL(url).pathname
      if (path !== '/health') {return await base(url, options)}
      healthCalls += 1
      if (healthCalls === 1) {return new Response('warming up', { status: 503 })}
      return await base(url, options)
    }
  })
  assert.equal(healthCalls, 2)
  assert.equal(result.cellId, config.cellId)
})

test('fails when both director health attempts return a transient 503', async () => {
  const base = harness()
  let healthCalls = 0
  await assert.rejects(
    verifyCapacityTransition(config, {
      token: 'masked-token',
      wait: async () => {},
      fetch: async (url, options) => {
        const path = new URL(url).pathname
        if (path !== '/health') {return await base(url, options)}
        healthCalls += 1
        return new Response('warming up', { status: 503 })
      }
    }),
    /director health returned 503/
  )
  assert.equal(healthCalls, 2)
})

test('requires the drain pace window exactly for a live restart-safe wait', () => {
  const base = [
    '--director-origin', 'https://relay.example.com',
    '--cell-origin', 'https://c3.relay.example.com',
    '--cell-id', 'staging-gce-c3',
    '--heartbeat', 'either',
    '--admission', 'migration-only',
    '--draining', 'required'
  ]
  assert.equal(
    parseCapacityTransitionArguments([
      ...base, '--activity', 'restart-safe', '--pace-window-ms', '300000'
    ]).paceWindowMs,
    300_000
  )
  assert.throws(
    () => parseCapacityTransitionArguments([...base, '--activity', 'restart-safe']),
    /required exactly for restart-safe/
  )
  assert.throws(
    () => parseCapacityTransitionArguments([
      ...base, '--activity', 'allowed', '--pace-window-ms', '300000'
    ]),
    /required exactly for restart-safe/
  )
  assert.throws(
    () => parseCapacityTransitionArguments([
      ...base, '--activity', 'restart-safe', '--pace-window-ms', '-1'
    ]),
    /--pace-window-ms is invalid/
  )
})

test('passes after one pace window of an empty runtime and reports stranded leases', async () => {
  const lines = []
  let runtimeReads = 0
  const base = harness(strandedCell)
  const result = await verifyCapacityTransition(pacedRestartConfig, {
    fetch: async (url, options) => {
      if (new URL(url).pathname === '/v1/admin/runtime-status') {runtimeReads += 1}
      return await base(url, options)
    },
    token: 'masked-token',
    progress: (line) => lines.push(line),
    ...fakeClock()
  })
  // One sample at each end of a full five-minute pace window.
  assert.equal(runtimeReads, 61)
  assert.deepEqual(result.stranded, {
    restartBlockingActivityLeases: 4,
    restartBlockingActivityRequestUnits: 4,
    restartBlockingReservedRequests: -2,
    outgoingMigrations: 0,
    incomingMigrations: 0
  })
  // Every sample but the passing one prints its progress with the stranded counts.
  assert.equal(lines.length, 60)
  assert.ok(lines.every((line) =>
    line.event === 'relay_capacity_transition_restart_progress' &&
    line.requiredRestartSafeSamples === 61 &&
    line.stranded.restartBlockingActivityLeases === 4))
  assert.deepEqual(lines.slice(0, 2).map((line) => line.restartSafeSamples), [1, 2])
})

test('the pace window resets on any non-zero runtime sample', async () => {
  const quiet = harness(strandedCell)
  const busy = harness({ ...strandedCell, controls: 1 })
  let runtimeReads = 0
  const lines = []
  await verifyCapacityTransition(pacedRestartConfig, {
    fetch: async (url, options) => {
      if (new URL(url).pathname === '/v1/admin/runtime-status') {runtimeReads += 1}
      return await (runtimeReads === 30 ? busy : quiet)(url, options)
    },
    token: 'masked-token',
    progress: (line) => lines.push(line),
    ...fakeClock()
  })
  assert.equal(runtimeReads, 91)
  assert.deepEqual(lines.slice(28, 31).map((line) => line.restartSafeSamples), [29, 0, 1])
  await assert.rejects(
    verifyCapacityTransition(
      { ...pacedRestartConfig, timeoutMs: 295_000 },
      { fetch: quiet, token: 'masked-token', progress: () => {}, ...fakeClock() }
    ),
    /"restartSafeSamples":60,"requiredRestartSafeSamples":61/
  )
})
