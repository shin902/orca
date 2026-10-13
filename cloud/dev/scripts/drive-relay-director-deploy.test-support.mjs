import assert from 'node:assert/strict'

import { createHash } from 'node:crypto'

import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'

import { tmpdir } from 'node:os'

import { join } from 'node:path'

import { test } from 'node:test'

import {
  MONITOR_MAX_AGE_AT_ENABLE_MS,
  createDriver,
  parseDriverArguments
} from './drive-relay-director-deploy.mjs'

import {
  IMAGE_REPOSITORY,
  REPOSITORY,
  WORKFLOWS,
  blocksDeploy,
  parseConfigureWave,
  pausedGeneration,
  rehomeResultFromLog,
  validateDispatchInputs
} from './relay-director-deploy-plan.mjs'

import { RELAY_WORKFLOW_FILE_PREFIX, relayWorkflowPath } from './relay-repository.mjs'

import {
  COMMIT,
  OLD,
  NEW,
  CELL,
  START,
  MEMBERSHIP,
  CONTROL,
  controlLine,
  monitorFiles,
  fakeWorld,
  promote,
  nextGeneration,
  simulate,
  flag,
  gh,
  gcloud,
  dependencies,
  logDirectory,
  drive,
  start,
  rerun,
  stopped,
  keys,
  dispatched,
  REHOME,
  DEPLOY,
  PUBLISH,
  MONITOR,
  report,
  live
} from './drive-relay-director-deploy-fixture.mjs'
