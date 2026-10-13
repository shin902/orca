import assert from 'node:assert/strict'

import { test } from 'node:test'

import {
  RELAY_CELL_CONNECTION_DRAIN_SECONDS,
  RELAY_CELL_LOG_SAMPLE_RATE
} from './validate-relay-asia-topology-plan.mjs'

import { readFileSync } from 'node:fs'

import {
  DECLARED_MANAGER_FIELDS,
  parseCapacityPlanArguments,
  validateCapacityPlan as validateCapacityPlanRaw
} from './validate-relay-capacity-plan.mjs'



export const config = {
  cellId: 'staging-gce-c3',
  hardCap: 1_000,
  unobservedBound: 60
}

export function replacementConfiguration(references = [
  'google_compute_instance_template.relay_gce_cell',
  'each.key'
]) {
  return {
    root_module: {
      resources: [{
        address: 'google_compute_instance_group_manager.relay_gce_cell',
        expressions: {
          version: [{
            instance_template: { references },
            name: { constant_value: 'primary' }
          }]
        }
      }]
    }
  }
}

export function validateCapacityPlan(plan, planConfig) {
  const replacement = plan.resource_changes.some(({ change }) =>
    JSON.stringify(change?.actions) === JSON.stringify(['create', 'delete']))
  return validateCapacityPlanRaw(
    replacement && !plan.configuration
      ? { ...plan, configuration: replacementConfiguration() }
      : plan,
    planConfig
  )
}

