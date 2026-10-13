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

test('a same-cap roll may gain the pinned capacity identity but never move it', () => {
  const rollbackImage = `us-docker.pkg.dev/project/relay/image@sha256:${'d'.repeat(64)}`
  const image = `us-docker.pkg.dev/project/relay/image@sha256:${'e'.repeat(64)}`
  const directorIdentity = 'relay-director@project.iam.gserviceaccount.com'
  const capacityIdentity = 'orca-cloud-gha-cap@project.iam.gserviceaccount.com'
  const audience = 'https://relay.example.com/v1/admin/host-drain'
  const startup = ({ selectedImage, capacity }) => [
    `  printf 'ORCA_RELAY_CELL_CONNECTION_HARD_CAP=%s\\n' '600'`,
    `  printf 'ORCA_RELAY_CELL_CONNECTION_UNOBSERVED_BOUND=%s\\n' '60'`,
    ...(capacity === null
      ? []
      : [`  printf 'ORCA_RELAY_CAPACITY_SERVICE_ACCOUNT=%s\\n' '${capacity}'`]),
    `printf 'ORCA_RELAY_IMAGE_DIGEST=%s\\n' '${selectedImage.split('@')[1]}'`,
    `docker pull '${selectedImage}'`,
    'docker run --detach \\',
    '  --name orca-relay \\',
    `  '${selectedImage}'`
  ].join('\n')
  const plan = (beforeCapacity, afterCapacity) => ({
    resource_changes: [
      {
        address: 'google_compute_instance_template.relay_gce_cell["production-gce-c17"]',
        change: {
          actions: ['create', 'delete'],
          before: {
            metadata_startup_script: startup({
              selectedImage: rollbackImage,
              capacity: beforeCapacity
            })
          },
          after: {
            metadata_startup_script: startup({ selectedImage: image, capacity: afterCapacity }),
            self_link: null
          },
          after_unknown: { self_link: true }
        }
      },
      {
        address: 'google_compute_instance_group_manager.relay_gce_cell["production-gce-c17"]',
        change: {
          actions: ['update'],
          before: { target_size: 1, version: [{ instance_template: 'old' }] },
          after: { target_size: 1, version: [{ instance_template: null }] },
          after_unknown: { version: [{ instance_template: true }] }
        }
      }
    ]
  })
  const config = {
    cellId: 'production-gce-c17',
    hardCap: 600,
    unobservedBound: 60,
    mode: 'same-cap-cell',
    image,
    rollbackImage,
    capacityServiceAccount: capacityIdentity,
    rehomeDirectorServiceAccount: directorIdentity,
    rehomeAudience: audience,
    regionalRehomeProtocol: '0'
  }
  // A template old enough to predate the line gains it, which is the only move allowed.
  assert.deepEqual(
    validateCapacityPlan(plan(null, capacityIdentity), config),
    { mode: 'same-cap-cell', changes: 2 }
  )
  assert.deepEqual(
    validateCapacityPlan(plan(capacityIdentity, capacityIdentity), config),
    { mode: 'same-cap-cell', changes: 2 }
  )
  for (const [before, after] of [
    [capacityIdentity, null],
    [null, null],
    [capacityIdentity, 'orca-cloud-gha-other@project.iam.gserviceaccount.com'],
    [null, 'orca-cloud-gha-other@project.iam.gserviceaccount.com']
  ]) {
    assert.throws(
      () => validateCapacityPlan(plan(before, after), config),
      /reviewed image and capacity/,
      `${before} -> ${after}`
    )
  }
  // Without the pin there is nothing reviewing the line the comparison now ignores.
  assert.throws(
    () => validateCapacityPlan(plan(null, capacityIdentity), {
      ...config,
      capacityServiceAccount: undefined
    }),
    /invalid service account/
  )
  assert.throws(
    () => validateCapacityPlan(plan(null, capacityIdentity), {
      ...config,
      capacityServiceAccount: 'not-an-email'
    }),
    /invalid service account/
  )
})

test('the capacity identity argument is required by same-cap-cell mode', () => {
  const image = `us-docker.pkg.dev/project/relay/image@sha256:${'e'.repeat(64)}`
  const rollbackImage = `us-docker.pkg.dev/project/relay/image@sha256:${'d'.repeat(64)}`
  const base = [
    '--mode', 'same-cap-cell',
    '--cell-id', 'production-gce-c17',
    '--hard-cap', '600',
    '--unobserved-bound', '60',
    '--image', image,
    '--rollback-image', rollbackImage,
    '--rehome-director-service-account', 'relay-director@project.iam.gserviceaccount.com',
    '--rehome-audience', 'https://relay.onorca.dev/v1/admin/host-drain',
    '--regional-rehome-protocol', '0'
  ]
  assert.throws(() => parseCapacityPlanArguments(base), /missing --capacity-service-account/)
  assert.throws(
    () => parseCapacityPlanArguments([...base, '--capacity-service-account', 'nope']),
    /--capacity-service-account is invalid/
  )
  assert.equal(
    parseCapacityPlanArguments([
      ...base,
      '--capacity-service-account',
      'orca-cloud-gha-cap@project.iam.gserviceaccount.com'
    ]).capacityServiceAccount,
    'orca-cloud-gha-cap@project.iam.gserviceaccount.com'
  )
})

test('the rehome protocol argument is required by same-cap-cell mode alone', () => {
  const image = `us-docker.pkg.dev/project/relay/image@sha256:${'e'.repeat(64)}`
  const rollbackImage = `us-docker.pkg.dev/project/relay/image@sha256:${'d'.repeat(64)}`
  const sameCapArguments = (...extra) => [
    '--mode', 'same-cap-cell',
    '--cell-id', 'production-gce-c27',
    '--hard-cap', '3000',
    '--unobserved-bound', '60',
    '--image', image,
    '--rollback-image', rollbackImage,
    '--capacity-service-account', 'orca-cloud-gha-cap@project.iam.gserviceaccount.com',
    '--rehome-director-service-account', 'relay-director@project.iam.gserviceaccount.com',
    '--rehome-audience', 'https://relay.onorca.dev/v1/admin/host-drain',
    ...extra
  ]
  assert.equal(
    parseCapacityPlanArguments(sameCapArguments('--regional-rehome-protocol', '0'))
      .regionalRehomeProtocol,
    '0'
  )
  assert.equal(
    parseCapacityPlanArguments(sameCapArguments('--regional-rehome-protocol', '3')).regionalRehomeProtocol,
    '3'
  )
  assert.throws(
    () => parseCapacityPlanArguments(sameCapArguments()),
    /requires rollback image and rehome trust config/
  )
  for (const protocol of ['', '2', 'true']) {
    assert.throws(
      () => parseCapacityPlanArguments(sameCapArguments('--regional-rehome-protocol', protocol)),
      /requires rollback image and rehome trust config/
    )
  }
  assert.throws(
    () => parseCapacityPlanArguments([
      '--mode', 'bootstrap-cell',
      '--cell-id', 'staging-gce-c3',
      '--hard-cap', '1000',
      '--unobserved-bound', '60',
      '--image', image,
      '--capacity-service-account', 'orca-cap@onorca-cloud.iam.gserviceaccount.com',
      '--regional-rehome-protocol', '0'
    ]),
    /applies only to same-cap-cell validation/
  )
})

test('the reviewed database pool is pinned for the cells that emit one', () => {
  const rollbackImage = `us-docker.pkg.dev/project/relay/image@sha256:${'d'.repeat(64)}`
  const image = `us-docker.pkg.dev/project/relay/image@sha256:${'e'.repeat(64)}`
  const directorIdentity = 'relay-director@project.iam.gserviceaccount.com'
  const capacityIdentity = 'orca-cloud-gha-cap@project.iam.gserviceaccount.com'
  const audience = 'https://relay.example.com/v1/admin/host-drain'
  const startup = ({ selectedImage, pool }) => [
    `  printf 'ORCA_RELAY_CELL_CONNECTION_HARD_CAP=%s\\n' '3000'`,
    `  printf 'ORCA_RELAY_CELL_CONNECTION_UNOBSERVED_BOUND=%s\\n' '60'`,
    `  printf 'ORCA_RELAY_CAPACITY_SERVICE_ACCOUNT=%s\\n' '${capacityIdentity}'`,
    ...(pool === undefined
      ? []
      : [`  printf 'ORCA_RELAY_DATABASE_POOL_MAX=%s\\n' '${pool}'`]),
    `  printf 'ORCA_RELAY_REHOME_DIRECTOR_SERVICE_ACCOUNT=%s\\n' '${directorIdentity}'`,
    `  printf 'ORCA_RELAY_REHOME_AUDIENCE=%s\\n' '${audience}'`,
    `printf 'ORCA_RELAY_IMAGE_DIGEST=%s\\n' '${selectedImage.split('@')[1]}'`,
    `docker pull '${selectedImage}'`,
    'docker run --detach \\',
    '  --name orca-relay \\',
    `  '${selectedImage}'`
  ].join('\n')
  const rollPlan = (before, after) => ({
    resource_changes: [
      {
        address: 'google_compute_instance_template.relay_gce_cell["production-gce-c27"]',
        change: {
          actions: ['create', 'delete'],
          before: {
            metadata_startup_script: startup({ selectedImage: rollbackImage, pool: before })
          },
          after: {
            metadata_startup_script: startup({ selectedImage: image, pool: after }),
            self_link: null
          },
          after_unknown: { self_link: true }
        }
      },
      {
        address: 'google_compute_instance_group_manager.relay_gce_cell["production-gce-c27"]',
        change: {
          actions: ['update'],
          before: { target_size: 1, version: [{ instance_template: 'old' }] },
          after: { target_size: 1, version: [{ instance_template: null }] },
          after_unknown: { version: [{ instance_template: true }] }
        }
      }
    ]
  })
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
    regionalRehomeProtocol: '1'
  }
  // The live template still says 10 while the reviewed plan says 16; only the pin bridges that.
  assert.deepEqual(
    validateCapacityPlan(rollPlan('10', '16'), { ...asiaConfig, databasePoolMax: '16' }),
    { mode: 'same-cap-cell', changes: 2 }
  )
  assert.throws(
    () => validateCapacityPlan(rollPlan('10', '16'), asiaConfig),
    /reviewed image and capacity/
  )
  assert.throws(
    () => validateCapacityPlan(rollPlan('10', '12'), { ...asiaConfig, databasePoolMax: '16' }),
    /reviewed image and capacity/
  )
  // A cell on the root pool default emits no line at all, and gaining one is real drift.
  assert.deepEqual(
    validateCapacityPlan(rollPlan(undefined, undefined), asiaConfig),
    { mode: 'same-cap-cell', changes: 2 }
  )
  assert.throws(
    () => validateCapacityPlan(rollPlan(undefined, '16'), asiaConfig),
    /reviewed image and capacity/
  )
  // A line already on the live template is still unreviewed without the pin, even standing still.
  assert.throws(
    () => validateCapacityPlan(rollPlan('16', '16'), asiaConfig),
    /reviewed image and capacity/
  )
  // A pin must also fail closed when the plan drops the line it names.
  assert.throws(
    () => validateCapacityPlan(rollPlan('16', undefined), { ...asiaConfig, databasePoolMax: '16' }),
    /reviewed image and capacity/
  )
  for (const pool of ['', '0', '101', 'ten']) {
    assert.throws(
      () => validateCapacityPlan(rollPlan('10', '16'), { ...asiaConfig, databasePoolMax: pool }),
      /invalid database pool max/
    )
  }
})

test('the database pool argument is accepted by same-cap-cell mode alone', () => {
  const image = `us-docker.pkg.dev/project/relay/image@sha256:${'e'.repeat(64)}`
  const rollbackImage = `us-docker.pkg.dev/project/relay/image@sha256:${'d'.repeat(64)}`
  const sameCapArguments = (...extra) => [
    '--mode', 'same-cap-cell',
    '--cell-id', 'production-gce-c27',
    '--hard-cap', '3000',
    '--unobserved-bound', '60',
    '--image', image,
    '--rollback-image', rollbackImage,
    '--capacity-service-account', 'orca-cloud-gha-cap@project.iam.gserviceaccount.com',
    '--rehome-director-service-account', 'relay-director@project.iam.gserviceaccount.com',
    '--rehome-audience', 'https://relay.onorca.dev/v1/admin/host-drain',
    '--regional-rehome-protocol', '1',
    ...extra
  ]
  assert.equal(
    parseCapacityPlanArguments(sameCapArguments('--database-pool-max', '16')).databasePoolMax,
    '16'
  )
  assert.equal(parseCapacityPlanArguments(sameCapArguments()).databasePoolMax, undefined)
  assert.throws(
    () => parseCapacityPlanArguments([
      '--mode', 'bootstrap-cell',
      '--cell-id', 'staging-gce-c3',
      '--hard-cap', '1000',
      '--unobserved-bound', '60',
      '--image', image,
      '--capacity-service-account', 'orca-cap@onorca-cloud.iam.gserviceaccount.com',
      '--database-pool-max', '16'
    ]),
    /applies only to same-cap-cell validation/
  )
})

test('a same-cap roll may carry only this cell backend drain and request logging', () => {
  const rollbackImage = `us-docker.pkg.dev/project/relay/image@sha256:${'d'.repeat(64)}`
  const image = `us-docker.pkg.dev/project/relay/image@sha256:${'e'.repeat(64)}`
  const capacityIdentity = 'orca-cloud-gha-cap@project.iam.gserviceaccount.com'
  const startup = (selectedImage) => [
    "  printf 'ORCA_RELAY_CELL_CONNECTION_HARD_CAP=%s\\n' '1000'",
    "  printf 'ORCA_RELAY_CELL_CONNECTION_UNOBSERVED_BOUND=%s\\n' '60'",
    `  printf 'ORCA_RELAY_CAPACITY_SERVICE_ACCOUNT=%s\\n' '${capacityIdentity}'`,
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
      before: { metadata_startup_script: startup(rollbackImage) },
      after: { metadata_startup_script: startup(image), self_link: null },
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
  // The exact shape a live US cell's backend plans: 300 s drain and no log_config at all.
  const loggingAfter = [{
    enable: true,
    optional_fields: null,
    optional_mode: null,
    sample_rate: RELAY_CELL_LOG_SAMPLE_RATE
  }]
  const backendChange = ({ drain = true, logging = true }) => ({
    address: 'google_compute_backend_service.relay_gce_cell["staging-gce-c3"]',
    change: {
      actions: ['update'],
      before: {
        connection_draining_timeout_sec: drain ? 300 : RELAY_CELL_CONNECTION_DRAIN_SECONDS,
        log_config: logging ? [] : loggingAfter,
        timeout_sec: 86_400,
        fingerprint: 'before'
      },
      after: {
        connection_draining_timeout_sec: RELAY_CELL_CONNECTION_DRAIN_SECONDS,
        log_config: loggingAfter,
        timeout_sec: 86_400,
        fingerprint: null
      },
      after_unknown: { fingerprint: true }
    }
  })
  const backend = backendChange({})
  const drainOnly = backendChange({ logging: false })
  const loggingOnly = backendChange({ drain: false })
  const sameCapConfig = {
    ...config,
    mode: 'same-cap-cell',
    image,
    rollbackImage,
    capacityServiceAccount: capacityIdentity,
    rehomeDirectorServiceAccount: 'relay-director@project.iam.gserviceaccount.com',
    rehomeAudience: 'https://relay.onorca.dev/v1/admin/host-drain',
    regionalRehomeProtocol: '0'
  }
  const refused = /only this cell backend drain and request logging/
  // Both attributes ride along with the roll without inflating the template-and-MIG count
  // the apply's stranded branch and the resume's drift branch both read.
  assert.deepEqual(
    validateCapacityPlan({ resource_changes: [template, manager, backend] }, sameCapConfig),
    {
      mode: 'same-cap-cell',
      changes: 2,
      backendUpdate: ['connection_draining_timeout_sec', 'log_config.0']
    }
  )
  // Each is independently optional: a cell that already has one plans no change for it.
  assert.deepEqual(
    validateCapacityPlan({ resource_changes: [template, manager, drainOnly] }, sameCapConfig),
    { mode: 'same-cap-cell', changes: 2, backendUpdate: ['connection_draining_timeout_sec'] }
  )
  assert.deepEqual(
    validateCapacityPlan({ resource_changes: [template, manager, loggingOnly] }, sameCapConfig),
    { mode: 'same-cap-cell', changes: 2, backendUpdate: ['log_config.0'] }
  )
  // Once both are applied the backend is simply absent from the plan.
  assert.deepEqual(
    validateCapacityPlan({ resource_changes: [template, manager] }, sameCapConfig),
    { mode: 'same-cap-cell', changes: 2 }
  )
  // A cell whose template and MIG have converged but whose backend has not is still clean.
  assert.deepEqual(
    validateCapacityPlan({ resource_changes: [backend] }, sameCapConfig),
    {
      mode: 'same-cap-cell',
      changes: 0,
      backendUpdate: ['connection_draining_timeout_sec', 'log_config.0']
    }
  )
  assert.deepEqual(validateCapacityPlan({ resource_changes: [] }, sameCapConfig), {
    mode: 'same-cap-cell',
    changes: 0
  })
  const extraAttribute = structuredClone(backend)
  extraAttribute.change.after.timeout_sec = 3_600
  assert.throws(
    () => validateCapacityPlan(
      { resource_changes: [template, manager, extraAttribute] },
      sameCapConfig
    ),
    /changes outside the reviewed capacity fields/
  )
  const otherCell = structuredClone(backend)
  otherCell.address = 'google_compute_backend_service.relay_gce_cell["production-gce-c27"]'
  assert.throws(
    () => validateCapacityPlan({ resource_changes: [template, manager, otherCell] }, sameCapConfig),
    refused
  )
  const unreviewedDrain = structuredClone(backend)
  unreviewedDrain.change.after.connection_draining_timeout_sec =
    RELAY_CELL_CONNECTION_DRAIN_SECONDS + 1
  assert.throws(
    () => validateCapacityPlan(
      { resource_changes: [template, manager, unreviewedDrain] },
      sameCapConfig
    ),
    refused
  )
  const sampledLogging = structuredClone(backend)
  sampledLogging.change.after.log_config[0].sample_rate = RELAY_CELL_LOG_SAMPLE_RATE / 2
  assert.throws(
    () => validateCapacityPlan(
      { resource_changes: [template, manager, sampledLogging] },
      sameCapConfig
    ),
    refused
  )
  const disabledLogging = structuredClone(backend)
  disabledLogging.change.after.log_config[0].enable = false
  assert.throws(
    () => validateCapacityPlan(
      { resource_changes: [template, manager, disabledLogging] },
      sameCapConfig
    ),
    refused
  )
  const replaced = structuredClone(backend)
  replaced.change.actions = ['create', 'delete']
  assert.throws(
    () => validateCapacityPlan({ resource_changes: [template, manager, replaced] }, sameCapConfig),
    refused
  )
  // Only the same-cap wave targets a backend service; every other mode still refuses one.
  assert.throws(
    () => validateCapacityPlan(
      { resource_changes: [template, manager, backend] },
      { ...config, mode: 'cell', image }
    ),
    /only the exact instance template and MIG/
  )
})

// The reconciliation allowance is only safe while it names exactly what Terraform declares.

test('the declared MIG fields match relay-gce-cells.tf', () => {
  const terraform = readFileSync(
    new URL('../../infra/terraform/relay-gce-cells.tf', import.meta.url),
    'utf8'
  )
  const manager = terraform
    .split('resource "google_compute_instance_group_manager" "relay_gce_cell" {')[1]
    ?.split('\n}')[0] ?? ''
  const block = (name) => manager.split(`  ${name} {`)[1]?.split('\n  }')[0] ?? ''
  const topology = terraform.split('  relay_gce_topology = {')[1]?.split('\n  }')[0] ?? ''
  const attribute = (source, name) => {
    const raw = new RegExp(`\\n\\s+${name}\\s+= (.+)`).exec(source)?.[1]
    assert.notEqual(raw, undefined, `relay-gce-cells.tf declares no ${name}`)
    const local = /^local\.relay_gce_topology\.(\w+)$/.exec(raw)?.[1]
    if (local) {return Number(new RegExp(`${local}\\s+= (\\d+)`).exec(topology)?.[1])}
    return JSON.parse(raw)
  }
  const declared = Object.fromEntries(
    Object.keys(DECLARED_MANAGER_FIELDS).map((path) => {
      const [blockName, , field] = path.split('.')
      return [path, attribute(block(blockName), field)]
    })
  )
  assert.deepEqual(declared, { ...DECLARED_MANAGER_FIELDS })
})
