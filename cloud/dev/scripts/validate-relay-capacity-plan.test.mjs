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


import {
  config,
  replacementConfiguration,
  validateCapacityPlan
} from './validate-relay-capacity-plan.test-support.mjs'

test('accepts only the exact canary template replacement and MIG update', () => {
  const image = `us-docker.pkg.dev/project/relay/image@sha256:${'a'.repeat(64)}`
  const startupScript = (cap, bound, selectedImage, extra = '') =>
    [
      `  printf 'ORCA_RELAY_CELL_CONNECTION_HARD_CAP=%s\\n' '${cap}'`,
      `  printf 'ORCA_RELAY_CELL_CONNECTION_UNOBSERVED_BOUND=%s\\n' '${bound}'`,
      `printf 'ORCA_RELAY_IMAGE_DIGEST=%s\\n' '${selectedImage.split('@')[1]}'`,
      `docker pull '${selectedImage}'`,
      extra,
      'docker run --detach \\',
      '  --name cloud-sql-proxy \\',
      `  'us-docker.pkg.dev/project/proxy@sha256:${'c'.repeat(64)}'`,
      'docker run --detach \\',
      '  --name orca-relay \\',
      `  '${selectedImage}'`
    ].join('\n')
  const script = startupScript(1_000, 60, image)
  const template = {
    address: 'google_compute_instance_template.relay_gce_cell["staging-gce-c3"]',
    change: {
      actions: ['create', 'delete'],
      before: {
        metadata_startup_script: startupScript(
          600,
          60,
          `us-docker.pkg.dev/project/relay/image@sha256:${'b'.repeat(64)}`
        )
      },
      after: { metadata_startup_script: script, self_link: null },
      after_unknown: { self_link: true }
    }
  }
  const manager = {
    address: 'google_compute_instance_group_manager.relay_gce_cell["staging-gce-c3"]',
    change: {
      actions: ['update'],
      before: { target_size: 1, version: [{ instance_template: 'old' }] },
      after: { target_size: 1, version: [{ instance_template: null }] },
      after_unknown: { version: [{ instance_template: true }] }
    }
  }
  const cellConfig = { ...config, mode: 'cell', image }
  assert.deepEqual(validateCapacityPlan({ resource_changes: [] }, cellConfig), {
    mode: 'cell',
    changes: 0
  })
  assert.deepEqual(validateCapacityPlan({ resource_changes: [template, manager] }, cellConfig), {
    mode: 'cell',
    changes: 2
  })
  const wrongTemplateManager = structuredClone(manager)
  wrongTemplateManager.change.after.version[0].instance_template =
    'projects/project/global/instanceTemplates/unreviewed'
  assert.throws(
    () => validateCapacityPlan(
      { resource_changes: [template, wrongTemplateManager] },
      cellConfig
    ),
    /does not bind the MIG/
  )
  assert.throws(
    () => validateCapacityPlanRaw(
      {
        resource_changes: [template, manager],
        configuration: replacementConfiguration([
          'google_compute_instance_template.relay_gce_cell',
          'var.unreviewed_key'
        ])
      },
      cellConfig
    ),
    /reviewed template dependency/
  )
  assert.throws(
    () => validateCapacityPlanRaw(
      { resource_changes: [template, manager] },
      cellConfig
    ),
    /reviewed template dependency/
  )
  const capacityServiceAccount =
    'orca-cloud-staging-gha-cap@onorca-cloud-staging.iam.gserviceaccount.com'
  const bootstrapTemplate = structuredClone(template)
  const bootstrapManager = structuredClone(manager)
  bootstrapTemplate.change.after.metadata_startup_script = [
    `  printf 'ORCA_RELAY_CAPACITY_SERVICE_ACCOUNT=%s\\n' '${capacityServiceAccount}'`,
    script
  ].join('\n')
  const bootstrapConfig = {
    ...cellConfig,
    mode: 'bootstrap-cell',
    capacityServiceAccount
  }
  const plannedValues = (startupScript) => ({
    root_module: {
      resources: [
        {
          address: bootstrapTemplate.address,
          values: {
            metadata_startup_script: startupScript,
            self_link: 'projects/project/global/instanceTemplates/c26-reviewed'
          }
        },
        {
          address: bootstrapManager.address,
          values: {
            version: [{
              instance_template:
                'https://www.googleapis.com/compute/v1/projects/project/global/instanceTemplates/c26-reviewed'
            }]
          }
        }
      ]
    }
  })
  assert.deepEqual(
    validateCapacityPlan(
      { resource_changes: [bootstrapTemplate, bootstrapManager] },
      bootstrapConfig
    ),
    { mode: 'bootstrap-cell', changes: 2 }
  )
  const managerOnly = structuredClone(bootstrapManager)
  assert.deepEqual(
    validateCapacityPlan(
      {
        resource_changes: [managerOnly],
        planned_values: plannedValues(
          bootstrapTemplate.change.after.metadata_startup_script
        )
      },
      bootstrapConfig
    ),
    { mode: 'bootstrap-cell', changes: 1 }
  )
  const decoyPlannedValues = plannedValues(
    `${bootstrapTemplate.change.after.metadata_startup_script.replaceAll(
      image,
      `us-docker.pkg.dev/project/relay/image@sha256:${'b'.repeat(64)}`
    )}\n# decoy '${image}'`
  )
  assert.throws(
    () => validateCapacityPlan(
      { resource_changes: [managerOnly], planned_values: decoyPlannedValues },
      bootstrapConfig
    ),
    /reviewed image and capacity/
  )
  const obsoleteTemplate = structuredClone(bootstrapTemplate)
  obsoleteTemplate.deposed = 'retired-template'
  obsoleteTemplate.change.actions = ['delete']
  obsoleteTemplate.change.after = null
  assert.deepEqual(
    validateCapacityPlan(
      {
        resource_changes: [managerOnly, obsoleteTemplate],
        planned_values: plannedValues(
          bootstrapTemplate.change.after.metadata_startup_script
        )
      },
      bootstrapConfig
    ),
    { mode: 'bootstrap-cell', changes: 2 }
  )
  assert.deepEqual(
    validateCapacityPlan(
      {
        resource_changes: [obsoleteTemplate],
        planned_values: plannedValues(
          bootstrapTemplate.change.after.metadata_startup_script
        )
      },
      bootstrapConfig
    ),
    { mode: 'bootstrap-cell', changes: 1 }
  )
  const wrongManagerReference = plannedValues(
    bootstrapTemplate.change.after.metadata_startup_script
  )
  wrongManagerReference.root_module.resources[1].values.version[0].instance_template =
    'projects/project/global/instanceTemplates/not-reviewed'
  assert.throws(
    () => validateCapacityPlan(
      { resource_changes: [managerOnly], planned_values: wrongManagerReference },
      bootstrapConfig
    ),
    /does not bind the MIG/
  )
  assert.throws(
    () => validateCapacityPlan(
      { resource_changes: [managerOnly] },
      bootstrapConfig
    ),
    /no exact planned C26 state/
  )
  // A MIG moving back to its declared label and update policy is reconciliation in every mode.
  const restartedBootstrapManager = structuredClone(bootstrapManager)
  restartedBootstrapManager.change.before.update_policy = [{ minimal_action: 'RESTART' }]
  restartedBootstrapManager.change.after.update_policy = [{ minimal_action: 'REPLACE' }]
  restartedBootstrapManager.change.before.version[0].name =
    '0/2026-08-10 23:30:14.196895+00:00'
  restartedBootstrapManager.change.after.version[0].name = 'primary'
  assert.deepEqual(
    validateCapacityPlan(
      { resource_changes: [bootstrapTemplate, restartedBootstrapManager] },
      bootstrapConfig
    ),
    { mode: 'bootstrap-cell', changes: 2 }
  )
  assert.deepEqual(
    validateCapacityPlan({ resource_changes: [template, restartedBootstrapManager] }, cellConfig),
    { mode: 'cell', changes: 2 }
  )
  const operatorLabelManager = structuredClone(restartedBootstrapManager)
  operatorLabelManager.change.before.version[0].name = 'operator-version'
  delete operatorLabelManager.change.before.update_policy
  delete operatorLabelManager.change.after.update_policy
  assert.deepEqual(
    validateCapacityPlan(
      { resource_changes: [bootstrapTemplate, operatorLabelManager] },
      bootstrapConfig
    ),
    { mode: 'bootstrap-cell', changes: 2 }
  )
  const unrecognizedPrimaryVersion = structuredClone(restartedBootstrapManager)
  unrecognizedPrimaryVersion.change.after.version[0].name = 'other'
  assert.throws(
    () =>
      validateCapacityPlan(
        { resource_changes: [bootstrapTemplate, unrecognizedPrimaryVersion] },
        bootstrapConfig
      ),
    /outside the reviewed capacity fields/
  )
  const unrecognizedRestoredPolicy = structuredClone(restartedBootstrapManager)
  unrecognizedRestoredPolicy.change.after.update_policy[0].minimal_action = 'REFRESH'
  assert.throws(
    () =>
      validateCapacityPlan(
        { resource_changes: [bootstrapTemplate, unrecognizedRestoredPolicy] },
        bootstrapConfig
      ),
    /outside the reviewed capacity fields/
  )
  // Gaining a whole policy block is not a field reverting, so it is not reconciliation.
  const addedPolicy = structuredClone(restartedBootstrapManager)
  delete addedPolicy.change.before.update_policy
  assert.throws(
    () =>
      validateCapacityPlan(
        { resource_changes: [bootstrapTemplate, addedPolicy] },
        bootstrapConfig
      ),
    /outside the reviewed capacity fields/
  )
  const duplicateHardCapTemplate = structuredClone(template)
  duplicateHardCapTemplate.change.after.metadata_startup_script = [
    script,
    `  printf 'ORCA_RELAY_CELL_CONNECTION_HARD_CAP=%s\\n' '600'`
  ].join('\n')
  assert.throws(
    () =>
      validateCapacityPlan(
        { resource_changes: [duplicateHardCapTemplate, structuredClone(manager)] },
        cellConfig
      ),
    /reviewed image and capacity/
  )
  const duplicateIdentityTemplate = structuredClone(bootstrapTemplate)
  duplicateIdentityTemplate.change.after.metadata_startup_script = [
    duplicateIdentityTemplate.change.after.metadata_startup_script,
    `  printf 'ORCA_RELAY_CAPACITY_SERVICE_ACCOUNT=%s\\n' 'other-capacity@onorca-cloud-staging.iam.gserviceaccount.com'`
  ].join('\n')
  assert.throws(
    () =>
      validateCapacityPlan(
        { resource_changes: [duplicateIdentityTemplate, structuredClone(bootstrapManager)] },
        bootstrapConfig
      ),
    /reviewed image and capacity/
  )
  assert.throws(
    () =>
      validateCapacityPlan(
        { resource_changes: [bootstrapTemplate, bootstrapManager] },
        { ...bootstrapConfig, capacityServiceAccount: 'invalid' }
      ),
    /invalid service account/
  )
  assert.throws(
    () =>
      validateCapacityPlan(
        { resource_changes: [bootstrapTemplate, bootstrapManager] },
        cellConfig
      ),
    /reviewed image and capacity/
  )
  manager.change.after.target_size = 0
  assert.throws(
    () => validateCapacityPlan({ resource_changes: [template, manager] }, cellConfig),
    /outside the reviewed capacity fields/
  )
  manager.change.after.target_size = 1
  template.change.after.metadata_startup_script = startupScript(1_000, 60, image, 'curl bad')
  assert.throws(
    () => validateCapacityPlan({ resource_changes: [template, manager] }, cellConfig),
    /reviewed image and capacity/
  )
  template.change.after.metadata_startup_script = startupScript(
    1_000,
    60,
    image,
    'curl bad # ORCA_RELAY_CELL_CONNECTION_HARD_CAP='
  )
  assert.throws(
    () => validateCapacityPlan({ resource_changes: [template, manager] }, cellConfig),
    /reviewed image and capacity/
  )
  template.change.after.metadata_startup_script = script
  template.change.after_unknown = {
    id: true,
    self_link: true,
    disk: [{ architecture: true }]
  }
  manager.change.after_unknown = {
    fingerprint: true,
    version: [{ instance_template: true }]
  }
  assert.deepEqual(validateCapacityPlan({ resource_changes: [template, manager] }, cellConfig), {
    mode: 'cell',
    changes: 2
  })
  template.change.before.description = ''
  template.change.after.description = null
  template.change.before.disk = [{
    architecture: '',
    source_image: 'projects/cos-cloud/global/images/cos-stable-1'
  }]
  template.change.after.disk = [{
    source_image: 'https://www.googleapis.com/compute/v1/projects/cos-cloud/global/images/cos-stable-1'
  }]
  template.change.after_unknown.disk = [{ architecture: true }]
  assert.deepEqual(validateCapacityPlan({ resource_changes: [template, manager] }, cellConfig), {
    mode: 'cell',
    changes: 2
  })
  template.change.after.disk[0].source_image =
    'https://www.googleapis.com/compute/v1/projects/cos-cloud/global/images/different'
  assert.throws(
    () => validateCapacityPlan({ resource_changes: [template, manager] }, cellConfig),
    /outside the reviewed capacity fields/
  )
  template.change.after.disk[0].source_image =
    'https://www.googleapis.com/compute/v1/projects/cos-cloud/global/images/cos-stable-1'
  manager.change.after_unknown = { target_size: true }
  assert.throws(
    () => validateCapacityPlan({ resource_changes: [template, manager] }, cellConfig),
    /outside the reviewed capacity fields/
  )
})
