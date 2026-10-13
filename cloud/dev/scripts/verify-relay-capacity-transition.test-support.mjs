import assert from 'node:assert/strict'

import { test } from 'node:test'

import {
  parseCapacityTransitionArguments,
  verifyCapacityTransition
} from './verify-relay-capacity-transition.mjs'



export const imageDigest = `sha256:${'a'.repeat(64)}`
export const config = {
  directorOrigin: 'https://relay.example.com',
  cellOrigin: 'https://c3.relay.example.com',
  cellId: 'staging-gce-c3',
  heartbeat: 'fresh',
  admission: 'non-general',
  draining: 'required',
  activity: 'quiescent',
  expectedImageDigests: [imageDigest],
  hardCap: 1_000,
  unobservedBound: 60,
  timeoutMs: 1
}

export function response(body) {
  return Response.json(body)
}

export function harness({
  heartbeatFresh = true,
  active = 0,
  preAuthConnections = 0,
  inFlightConnections = 0,
  reservedConnectionUnits = 0,
  enforcedConnectionUnits = active,
  activityLeases = active,
  activityRequestUnits = activityLeases,
  reservedRequests = activityRequestUnits,
  restartBlockingActivityLeases = activityLeases,
  restartBlockingActivityRequestUnits = activityRequestUnits,
  restartBlockingReservedRequests = reservedRequests,
  outgoingMigrations = 0,
  incomingMigrations = 0,
  controls = 0,
  splices = 0,
  pendingSplices = 0,
  queuedBytes = 0,
  pendingControlReservations = 0,
  runtimeHardCap = 1_000,
  directorHardCap = 1_000,
  runtimeImageDigest = imageDigest,
  protocol = 2,
  regionalRehomeProtocol = 1,
  legacy = false,
  admission = config.admission,
  draining = config.draining
} = {}) {
  return async (url) => {
    const parsed = new URL(url)
    if (parsed.pathname === '/health') {
      return response({ ok: true, connectionCapacityProtocol: protocol })
    }
    if (parsed.pathname === '/v1/admin/runtime-status') {
      return response({
        role: 'cell',
        cellId: config.cellId,
        cellUrl: config.cellOrigin,
        imageDigest: runtimeImageDigest,
        ...(regionalRehomeProtocol === null ? {} : { regionalRehomeProtocol }),
        draining: draining === 'required',
        connectionCapacity: legacy
          ? null
          : {
              hardCap: runtimeHardCap,
              unobservedBound: 60,
              controlRebindReserve: 100,
              ordinaryConnectionLimit: runtimeHardCap - 100,
              normalAdmissionPause: runtimeHardCap - 160
            },
        runtime: {
          totalConnections: active,
          preAuthConnections,
          controls,
          splices,
          pendingSplices,
          queuedBytes,
          ...(legacy ? {} : {
            inFlightConnections,
            reservedConnectionUnits,
            enforcedConnectionUnits
          })
        }
      })
    }
    return response({
      status: {
        cellId: config.cellId,
        cellUrl: config.cellOrigin,
        admissionState: admission === 'non-general' ? 'migration-only' : admission,
        runtime: { heartbeatFresh, cellUrl: config.cellOrigin },
        assignments: 900,
        activityLeases,
        activityRequestUnits,
        restartBlockingActivityLeases,
        restartBlockingActivityRequestUnits,
        restartBlockingReservedRequests,
        reservedRequests,
        outgoingMigrations,
        incomingMigrations,
        connectionCapacity: {
          hardCap: directorHardCap,
          unobservedBound: 60,
          controlRebindReserve: 100,
          ordinaryConnectionLimit: directorHardCap - 100,
          normalAdmissionPause: directorHardCap - 160,
          observedConnections: 0,
          inFlightConnections: 0,
          reservedConnectionUnits: 0,
          enforcedConnectionUnits: 0,
          pendingControlReservations,
          heartbeatFresh
        }
      }
    })
  }
}


// Production-gce-c28 on 2026-10-01: drained to an empty runtime while four hosts with no free
// slot anywhere kept redialling and held director leases on it.
export const strandedCell = {
  activityLeases: 10,
  activityRequestUnits: 10,
  reservedRequests: 4,
  restartBlockingActivityLeases: 4,
  restartBlockingActivityRequestUnits: 4,
  restartBlockingReservedRequests: -2,
  pendingControlReservations: 6
}
export const pacedRestartConfig = {
  ...config,
  admission: 'migration-only',
  activity: 'restart-safe',
  paceWindowMs: 300_000,
  timeoutMs: 1_200_000
}

export function fakeClock() {
  let now = 0
  return {
    now: () => now,
    wait: async (milliseconds) => {
      now += milliseconds
    }
  }
}

