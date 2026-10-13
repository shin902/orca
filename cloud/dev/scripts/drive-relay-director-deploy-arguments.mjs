import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { parseConfigureWave, requireCommit } from './relay-director-deploy-plan.mjs'

const RUN_ID = /^[1-9][0-9]*$/

export function parseDriverArguments(argv, home = homedir()) {
  const config = {
    dryRun: false,
    leaveRehomePaused: false,
    configure: [],
    logDirectory: join(home, '.orca', 'relay-director-deploy')
  }
  const runId = (value, key) => {
    if (!RUN_ID.test(value)) {
      throw new Error(`${key} must be a run ID`)
    }
    return Number(value)
  }
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index]
    if (key === '--dry-run' || key === '--leave-rehome-paused') {
      config[key === '--dry-run' ? 'dryRun' : 'leaveRehomePaused'] = true
      continue
    }
    const value = argv[index + 1]
    if (value === undefined || value.startsWith('--')) {
      throw new Error(`${key} needs a value`)
    }
    index += 1
    if (key === '--commit') {
      config.commit = requireCommit(value, '--commit')
    } else if (key === '--configure') {
      config.configure.push(parseConfigureWave(value))
    } else if (key === '--publish-run') {
      config.publishRun = runId(value, key)
    } else if (key === '--pause-run') {
      config.pauseRun = runId(value, key)
    } else if (key === '--rehome-generation') {
      if (!/^(0|[1-9][0-9]*)$/.test(value)) {
        throw new Error('--rehome-generation is invalid')
      }
      config.rehomeGeneration = Number(value)
    } else if (key === '--log-directory') {
      config.logDirectory = resolve(value)
    } else {
      throw new Error(`unsupported argument ${key}`)
    }
  }
  if (!config.commit) {
    throw new Error('missing --commit <40-character main commit to publish>')
  }
  if (config.pauseRun && config.leaveRehomePaused) {
    throw new Error('--pause-run and --leave-rehome-paused contradict each other')
  }
  return config
}
