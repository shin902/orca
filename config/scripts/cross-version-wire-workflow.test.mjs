import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'

const workflow = parse(readFileSync(join('.github', 'workflows', 'pr.yml'), 'utf8'))
const job = workflow.jobs['cross-version-wire']

describe('fork cross-version compatibility releases', () => {
  it('fetches every fixed release fixture from upstream before running the harness', () => {
    const fetchIndex = job.steps.findIndex(
      (step) => step.name === 'Fetch official compatibility releases'
    )
    const testIndex = job.steps.findIndex(
      (step) => step.name === 'Old/new client and server compatibility journeys'
    )
    expect(fetchIndex).toBeGreaterThanOrEqual(0)
    expect(testIndex).toBeGreaterThan(fetchIndex)
    const command = job.steps[fetchIndex].run
    expect(command).toContain(
      'git fetch --no-tags --filter=blob:none https://github.com/stablyai/orca.git'
    )
    expect(command).toContain(
      'refs/tags/$ORCA_CROSS_VERSION_BASELINE_REF:refs/tags/$ORCA_CROSS_VERSION_BASELINE_REF'
    )
    const directory = join('tests', 'e2e', 'cross-version-wire')
    const refs = new Set(
      readdirSync(directory)
        .filter((file) => file.endsWith('.unit.test.ts'))
        .flatMap((file) =>
          [
            ...readFileSync(join(directory, file), 'utf8').matchAll(
              /(?:const \w*REF = |materializeReleaseCheckout\()'(v\d+\.\d+\.\d+)'/g
            )
          ].map((match) => match[1])
        )
    )
    expect(refs.size).toBeGreaterThan(0)
    for (const ref of refs) {
      expect(command).toContain(`refs/tags/${ref}:refs/tags/${ref}`)
    }
    expect(command).not.toContain('refs/heads/')
    expect(command).not.toContain('refs/tags/*')
    expect(command).not.toContain('--force')
  })

  it('pins the baseline to the release being integrated and keeps tests in the background', () => {
    const desktop = JSON.parse(readFileSync('package.json', 'utf8'))
    expect(job.env.ORCA_CROSS_VERSION_BASELINE_REF).toBe(`v${desktop.version}`)
    expect(job.env.ORCA_BACKGROUND_LAUNCH).toBe('1')
  })
})
