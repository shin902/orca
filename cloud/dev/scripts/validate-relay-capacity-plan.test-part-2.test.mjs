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

test('same-cap mode preserves 1000/60 while adding only the reviewed trust config', () => {
  const rollbackImage = `us-docker.pkg.dev/project/relay/image@sha256:${'d'.repeat(64)}`
  const image = `us-docker.pkg.dev/project/relay/image@sha256:${'e'.repeat(64)}`
  const directorIdentity = 'relay-director@project.iam.gserviceaccount.com'
  const capacityIdentity = 'orca-cloud-gha-cap@project.iam.gserviceaccount.com'
  const audience = 'https://relay.example.com/v1/admin/host-drain'
  const startup = ({ selectedImage, cap = 1_000, trust = false, capacity = capacityIdentity }) => [
    `  printf 'ORCA_RELAY_CELL_CONNECTION_HARD_CAP=%s\\n' '${cap}'`,
    `  printf 'ORCA_RELAY_CELL_CONNECTION_UNOBSERVED_BOUND=%s\\n' '60'`,
    ...(capacity === null
      ? []
      : [`  printf 'ORCA_RELAY_CAPACITY_SERVICE_ACCOUNT=%s\\n' '${capacity}'`]),
    ...(trust ? [
      `  printf 'ORCA_RELAY_REHOME_DIRECTOR_SERVICE_ACCOUNT=%s\\n' '${directorIdentity}'`,
      `  printf 'ORCA_RELAY_REHOME_AUDIENCE=%s\\n' '${audience}'`
    ] : []),
    `printf 'ORCA_RELAY_IMAGE_DIGEST=%s\\n' '${selectedImage.split('@')[1]}'`,
    `docker pull '${selectedImage}'`,
    'docker run --detach \\',
    '  --name orca-relay \\',
    `  '${selectedImage}'`
  ].join('\n')
  const template = {
    address: 'google_compute_instance_template.relay_gce_cell["staging-gce-c3"]',
    change: {
      actions: ['create', 'delete'],
      before: { metadata_startup_script: startup({ selectedImage: rollbackImage }) },
      after: {
        metadata_startup_script: startup({ selectedImage: image, trust: true }),
        self_link: null
      },
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
  const sameCapConfig = {
    ...config,
    mode: 'same-cap-cell',
    image,
    rollbackImage,
    capacityServiceAccount: capacityIdentity,
    rehomeDirectorServiceAccount: directorIdentity,
    rehomeAudience: audience,
    regionalRehomeProtocol: '1'
  }
  assert.deepEqual(
    validateCapacityPlan({ resource_changes: [template, manager] }, sameCapConfig),
    { mode: 'same-cap-cell', changes: 2 }
  )
  // A gcloud rolling action on a stranded cell renamed its MIG version; the next roll reverts it.
  const relabelledManager = structuredClone(manager)
  relabelledManager.change.before.version[0].name = '0/2026-10-01 10:41:28.681518+00:00'
  relabelledManager.change.after.version[0].name = 'primary'
  assert.deepEqual(
    validateCapacityPlan({ resource_changes: [template, relabelledManager] }, sameCapConfig),
    { mode: 'same-cap-cell', changes: 2 }
  )
  for (const [field, moved] of [
    ['target_size', 0],
    ['base_instance_name', 'relay-other'],
    ['named_port', [{ name: 'relay', port: 9090 }]]
  ]) {
    const unrelated = structuredClone(relabelledManager)
    unrelated.change.after[field] = moved
    assert.throws(
      () => validateCapacityPlan({ resource_changes: [template, unrelated] }, sameCapConfig),
      /outside the reviewed capacity fields/,
      field
    )
  }
  const declaredPolicy = {
    type: 'PROACTIVE',
    minimal_action: 'REPLACE',
    most_disruptive_allowed_action: 'REPLACE',
    replacement_method: 'RECREATE',
    max_surge_fixed: 0,
    max_unavailable_fixed: 1
  }
  for (const [field, drifted, away] of [
    ['type', 'OPPORTUNISTIC', 'OPPORTUNISTIC'],
    ['minimal_action', 'RESTART', 'RESTART'],
    ['most_disruptive_allowed_action', 'RESTART', 'RESTART'],
    ['replacement_method', 'SUBSTITUTE', 'SUBSTITUTE'],
    ['max_surge_fixed', 1, 1],
    ['max_unavailable_fixed', 0, 0]
  ]) {
    const reverted = structuredClone(relabelledManager)
    reverted.change.before.update_policy = [{ ...declaredPolicy, [field]: drifted }]
    reverted.change.after.update_policy = [{ ...declaredPolicy }]
    assert.deepEqual(
      validateCapacityPlan({ resource_changes: [template, reverted] }, sameCapConfig),
      { mode: 'same-cap-cell', changes: 2 },
      field
    )
    const leaving = structuredClone(relabelledManager)
    leaving.change.before.update_policy = [{ ...declaredPolicy }]
    leaving.change.after.update_policy = [{ ...declaredPolicy, [field]: away }]
    assert.throws(
      () => validateCapacityPlan({ resource_changes: [template, leaving] }, sameCapConfig),
      /outside the reviewed capacity fields/,
      field
    )
  }
  // A second version is a canary split, never a label revert.
  const secondVersion = structuredClone(relabelledManager)
  secondVersion.change.after.version.push({
    name: 'primary',
    instance_template: 'projects/project/global/instanceTemplates/canary',
    target_size: [{ fixed: 1 }]
  })
  assert.throws(
    () => validateCapacityPlan({ resource_changes: [template, secondVersion] }, sameCapConfig),
    /outside the reviewed capacity fields/
  )
  // A stranded rollback whose template is already in place plans only the label revert.
  const plannedCell = (startupScript, templateLink) => ({
    root_module: {
      resources: [
        {
          address: 'google_compute_instance_template.relay_gce_cell["staging-gce-c3"]',
          values: { metadata_startup_script: startupScript, self_link: templateLink }
        },
        {
          address: 'google_compute_instance_group_manager.relay_gce_cell["staging-gce-c3"]',
          values: { version: [{ instance_template: templateLink, name: 'primary' }] }
        }
      ]
    }
  })
  const reviewedLink = 'projects/project/global/instanceTemplates/reviewed'
  const labelOnly = {
    address: manager.address,
    change: {
      actions: ['update'],
      before: {
        target_size: 1,
        version: [{ instance_template: reviewedLink, name: '0/2026-10-01 10:41:28.681518+00:00' }]
      },
      after: { target_size: 1, version: [{ instance_template: reviewedLink, name: 'primary' }] },
      after_unknown: {}
    }
  }
  const strandedPlan = (managerChange) => ({
    resource_changes: [managerChange],
    planned_values: plannedCell(template.change.after.metadata_startup_script, reviewedLink)
  })
  assert.deepEqual(
    validateCapacityPlan(strandedPlan(labelOnly), sameCapConfig),
    { mode: 'same-cap-cell', changes: 1 }
  )
  const labelAway = structuredClone(labelOnly)
  labelAway.change.before.version[0].name = 'primary'
  labelAway.change.after.version[0].name = 'other'
  assert.throws(
    () => validateCapacityPlan(strandedPlan(labelAway), sameCapConfig),
    /outside the reviewed capacity fields/
  )
  const labelAndResize = structuredClone(labelOnly)
  labelAndResize.change.after.target_size = 0
  assert.throws(
    () => validateCapacityPlan(strandedPlan(labelAndResize), sameCapConfig),
    /outside the reviewed capacity fields/
  )
  const percentSurge = structuredClone(relabelledManager)
  percentSurge.change.before.update_policy = [{ ...declaredPolicy, max_surge_percent: 0 }]
  percentSurge.change.after.update_policy = [{ ...declaredPolicy, max_surge_percent: 50 }]
  assert.throws(
    () => validateCapacityPlan({ resource_changes: [template, percentSurge] }, sameCapConfig),
    /outside the reviewed capacity fields/
  )
  // A pre-template-apply rollback resume validates drift for the image the
  // cell already serves: the template leaves and re-enters the rollback image.
  const resumeTemplate = structuredClone(template)
  resumeTemplate.change.after.metadata_startup_script = startup({
    selectedImage: rollbackImage,
    trust: true
  })
  assert.deepEqual(
    validateCapacityPlan(
      { resource_changes: [resumeTemplate, manager] },
      { ...sameCapConfig, image: rollbackImage }
    ),
    { mode: 'same-cap-cell', changes: 2 }
  )
  const asiaTemplate = structuredClone(template)
  const asiaManager = structuredClone(manager)
  asiaTemplate.address =
    'google_compute_instance_template.relay_gce_cell["production-gce-c28"]'
  asiaManager.address =
    'google_compute_instance_group_manager.relay_gce_cell["production-gce-c28"]'
  asiaTemplate.change.before.metadata_startup_script = startup({
    selectedImage: rollbackImage,
    cap: 3_000
  })
  asiaTemplate.change.after.metadata_startup_script = startup({
    selectedImage: image,
    cap: 3_000,
    trust: true
  })
  assert.deepEqual(
    validateCapacityPlan(
      { resource_changes: [asiaTemplate, asiaManager] },
      { ...sameCapConfig, cellId: 'production-gce-c28', hardCap: 3_000 }
    ),
    { mode: 'same-cap-cell', changes: 2 }
  )
  const changedCap = structuredClone(template)
  changedCap.change.before.metadata_startup_script = startup({
    selectedImage: rollbackImage,
    cap: 600
  })
  assert.throws(
    () => validateCapacityPlan({ resource_changes: [changedCap, manager] }, sameCapConfig),
    /reviewed image and capacity/
  )
  assert.throws(
    () => validateCapacityPlan(
      { resource_changes: [template, manager] },
      { ...sameCapConfig, rollbackImage: image }
    ),
    /reviewed image and capacity/
  )
  const wrongTrust = structuredClone(template)
  wrongTrust.change.after.metadata_startup_script = startup({
    selectedImage: image,
    trust: true
  }).replace(directorIdentity, 'other-director@project.iam.gserviceaccount.com')
  assert.throws(
    () => validateCapacityPlan({ resource_changes: [wrongTrust, manager] }, sameCapConfig),
    /reviewed image and capacity/
  )

  // Production run 35684694704 died after create_before_destroy made the new template, leaving
  // the Sep 18 template deposed; every later wave plan for that cell carries its delete.
  const deposedTemplate = structuredClone(template)
  deposedTemplate.deposed = '4cb19f83'
  deposedTemplate.change.actions = ['delete']
  deposedTemplate.change.after = null
  deposedTemplate.change.after_unknown = {}
  assert.deepEqual(
    validateCapacityPlan(
      { resource_changes: [template, manager, deposedTemplate] },
      sameCapConfig
    ),
    { mode: 'same-cap-cell', changes: 2, obsoleteTemplates: 1 }
  )
  const updatedDeposedTemplate = structuredClone(deposedTemplate)
  updatedDeposedTemplate.change.actions = ['update']
  assert.throws(
    () => validateCapacityPlan(
      { resource_changes: [template, manager, updatedDeposedTemplate] },
      sameCapConfig
    ),
    /change only the exact instance template and MIG/
  )
  const foreignDeposedTemplate = structuredClone(deposedTemplate)
  foreignDeposedTemplate.address =
    'google_compute_instance_template.relay_gce_cell["production-gce-c8"]'
  assert.throws(
    () => validateCapacityPlan(
      { resource_changes: [template, manager, foreignDeposedTemplate] },
      sameCapConfig
    ),
    /change only the exact instance template and MIG/
  )
  const secondDeposedTemplate = { ...structuredClone(deposedTemplate), deposed: 'aa17b204' }
  assert.throws(
    () => validateCapacityPlan(
      { resource_changes: [template, manager, deposedTemplate, secondDeposedTemplate] },
      sameCapConfig
    ),
    /change only the exact instance template and MIG/
  )
  // Nothing but the deposed delete left: the cell is stranded on the reviewed template, and the
  // job's `changes == 0` roll must still fire.
  assert.deepEqual(
    validateCapacityPlan(
      {
        resource_changes: [deposedTemplate],
        planned_values: {
          root_module: {
            resources: [
              {
                address: template.address,
                values: {
                  metadata_startup_script: template.change.after.metadata_startup_script,
                  self_link: 'projects/project/global/instanceTemplates/target'
                }
              },
              {
                address: manager.address,
                values: {
                  version: [{
                    instance_template: 'projects/project/global/instanceTemplates/target'
                  }]
                }
              }
            ]
          }
        }
      },
      sameCapConfig
    ),
    { mode: 'same-cap-cell', changes: 0, obsoleteTemplates: 1 }
  )

  const imageOnly = structuredClone(template)
  imageOnly.change.after.metadata_startup_script = startup({ selectedImage: image })
  const imageOnlyConfig = {
    ...config,
    mode: 'same-cap-image',
    image,
    rollbackImage
  }
  assert.deepEqual(
    validateCapacityPlan({ resource_changes: [imageOnly, manager] }, imageOnlyConfig),
    { mode: 'same-cap-image', changes: 2, changeKind: 'replacement' }
  )
  assert.throws(
    () => validateCapacityPlan(
      { resource_changes: [imageOnly, manager] },
      { ...imageOnlyConfig, rollbackImage: image }
    ),
    /reviewed image and capacity/
  )
  const changedTrust = structuredClone(imageOnly)
  changedTrust.change.after.metadata_startup_script +=
    `\n  printf 'ORCA_RELAY_REHOME_AUDIENCE=%s\\n' '${audience}'`
  assert.throws(
    () => validateCapacityPlan({ resource_changes: [changedTrust, manager] }, imageOnlyConfig),
    /reviewed image and capacity/
  )
  const plannedValues = {
    root_module: {
      resources: [
        {
          address: imageOnly.address,
          values: {
            metadata_startup_script: imageOnly.change.after.metadata_startup_script,
            self_link: 'projects/project/global/instanceTemplates/target'
          }
        },
        {
          address: manager.address,
          values: {
            version: [{ instance_template: 'projects/project/global/instanceTemplates/target' }]
          }
        }
      ]
    }
  }
  const obsoleteTemplate = structuredClone(imageOnly)
  obsoleteTemplate.deposed = 'obsolete'
  obsoleteTemplate.change.actions = ['delete']
  assert.deepEqual(
    validateCapacityPlan(
      { resource_changes: [obsoleteTemplate], planned_values: plannedValues },
      imageOnlyConfig
    ),
    { mode: 'same-cap-image', changes: 1, changeKind: 'obsolete-template-delete' }
  )
  assert.deepEqual(
    validateCapacityPlan(
      { resource_changes: [imageOnly, manager, obsoleteTemplate] },
      imageOnlyConfig
    ),
    { mode: 'same-cap-image', changes: 3, changeKind: 'replacement-with-obsolete-template' }
  )
  const anotherObsoleteTemplate = {
    ...structuredClone(obsoleteTemplate),
    deposed: 'another-obsolete'
  }
  assert.deepEqual(
    validateCapacityPlan(
      { resource_changes: [imageOnly, manager, obsoleteTemplate, anotherObsoleteTemplate] },
      imageOnlyConfig
    ),
    { mode: 'same-cap-image', changes: 4, changeKind: 'replacement-with-obsolete-template' }
  )
  assert.deepEqual(
    validateCapacityPlan(
      {
        resource_changes: [obsoleteTemplate, anotherObsoleteTemplate],
        planned_values: plannedValues
      },
      imageOnlyConfig
    ),
    { mode: 'same-cap-image', changes: 2, changeKind: 'obsolete-template-delete' }
  )
  assert.deepEqual(
    validateCapacityPlan(
      {
        resource_changes: [manager, obsoleteTemplate, anotherObsoleteTemplate],
        planned_values: plannedValues
      },
      imageOnlyConfig
    ),
    { mode: 'same-cap-image', changes: 3, changeKind: 'manager-convergence' }
  )
  const invalidObsoleteTemplate = structuredClone(anotherObsoleteTemplate)
  invalidObsoleteTemplate.change.actions = ['update']
  assert.throws(
    () => validateCapacityPlan(
      { resource_changes: [imageOnly, manager, obsoleteTemplate, invalidObsoleteTemplate] },
      imageOnlyConfig
    ),
    /change only the exact instance template and MIG/
  )
  assert.deepEqual(
    validateCapacityPlan(
      { resource_changes: [manager], planned_values: plannedValues },
      imageOnlyConfig
    ),
    { mode: 'same-cap-image', changes: 1, changeKind: 'manager-convergence' }
  )
})

test('protocol-0 same-cap cells roll without rehome trust lines', () => {
  const rollbackImage = `us-docker.pkg.dev/project/relay/image@sha256:${'d'.repeat(64)}`
  const image = `us-docker.pkg.dev/project/relay/image@sha256:${'e'.repeat(64)}`
  const directorIdentity = 'relay-director@project.iam.gserviceaccount.com'
  const capacityIdentity = 'orca-cloud-gha-cap@project.iam.gserviceaccount.com'
  const audience = 'https://relay.example.com/v1/admin/host-drain'
  const startup = ({ selectedImage, trust = false }) => [
    `  printf 'ORCA_RELAY_CELL_CONNECTION_HARD_CAP=%s\\n' '3000'`,
    `  printf 'ORCA_RELAY_CELL_CONNECTION_UNOBSERVED_BOUND=%s\\n' '60'`,
    `  printf 'ORCA_RELAY_CAPACITY_SERVICE_ACCOUNT=%s\\n' '${capacityIdentity}'`,
    `  printf 'ORCA_RELAY_CELL_REGION=%s\\n' 'asia-east2'`,
    ...(trust ? [
      `  printf 'ORCA_RELAY_REHOME_DIRECTOR_SERVICE_ACCOUNT=%s\\n' '${directorIdentity}'`,
      `  printf 'ORCA_RELAY_REHOME_AUDIENCE=%s\\n' '${audience}'`
    ] : []),
    `printf 'ORCA_RELAY_IMAGE_DIGEST=%s\\n' '${selectedImage.split('@')[1]}'`,
    `docker pull '${selectedImage}'`,
    'docker run --detach \\',
    '  --name orca-relay \\',
    `  '${selectedImage}'`
  ].join('\n')
  const template = {
    address: 'google_compute_instance_template.relay_gce_cell["production-gce-c27"]',
    change: {
      actions: ['create', 'delete'],
      before: { metadata_startup_script: startup({ selectedImage: rollbackImage }) },
      after: { metadata_startup_script: startup({ selectedImage: image }), self_link: null },
      after_unknown: { self_link: true }
    }
  }
  const manager = {
    address: 'google_compute_instance_group_manager.relay_gce_cell["production-gce-c27"]',
    change: {
      actions: ['update'],
      before: { target_size: 1, version: [{ instance_template: 'old' }] },
      after: { target_size: 1, version: [{ instance_template: null }] },
      after_unknown: { version: [{ instance_template: true }] }
    }
  }
  const asiaConfig = {
    cellId: 'production-gce-c27',
    hardCap: 3_000,
    unobservedBound: 60,
    mode: 'same-cap-cell',
    image,
    rollbackImage,
    capacityServiceAccount: capacityIdentity,
    rehomeDirectorServiceAccount: directorIdentity,
    rehomeAudience: audience,
    regionalRehomeProtocol: '0'
  }
  assert.deepEqual(
    validateCapacityPlan({ resource_changes: [template, manager] }, asiaConfig),
    { mode: 'same-cap-cell', changes: 2 }
  )
  const gainsTrust = structuredClone(template)
  gainsTrust.change.after.metadata_startup_script = startup({
    selectedImage: image,
    trust: true
  })
  assert.throws(
    () => validateCapacityPlan({ resource_changes: [gainsTrust, manager] }, asiaConfig),
    /reviewed image and capacity/
  )
  // Under protocol 1 that same script is the reviewed roll: trust is added, not drift.
  assert.deepEqual(
    validateCapacityPlan(
      { resource_changes: [gainsTrust, manager] },
      { ...asiaConfig, regionalRehomeProtocol: '1' }
    ),
    { mode: 'same-cap-cell', changes: 2 }
  )
  // A protocol-1 cell whose script has no rehome lines is the pre-existing failure, unchanged.
  assert.throws(
    () => validateCapacityPlan(
      { resource_changes: [template, manager] },
      { ...asiaConfig, regionalRehomeProtocol: '1' }
    ),
    /reviewed image and capacity/
  )
  for (const protocol of [undefined, '', '2', 'yes']) {
    assert.throws(
      () => validateCapacityPlan(
        { resource_changes: [template, manager] },
        { ...asiaConfig, regionalRehomeProtocol: protocol }
      ),
      /invalid regional rehome protocol/
    )
  }
})
