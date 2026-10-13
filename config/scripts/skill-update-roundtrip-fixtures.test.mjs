import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'

const workflow = parse(readFileSync('.github/workflows/skill-update-roundtrip.yml', 'utf8'))
const manifest = JSON.parse(readFileSync('resources/skills/current-manifest.json', 'utf8'))
const mapping = JSON.parse(readFileSync('resources/skills/release-mapping.json', 'utf8'))
const registry = JSON.parse(readFileSync('resources/skills/snapshot-registry.json', 'utf8'))

describe('fork skill update roundtrip fixtures', () => {
  it('fetches each historical snapshot used by the real update before verification', () => {
    const steps = workflow.jobs.roundtrip.steps
    const fetchIndex = steps.findIndex(
      (step) => step.name === 'Fetch official skill snapshot releases'
    )
    const verifyIndex = steps.findIndex(
      (step) => step.name === 'Verify targeted update convergence and copy behavior'
    )
    expect(fetchIndex).toBeGreaterThanOrEqual(0)
    expect(verifyIndex).toBeGreaterThan(fetchIndex)
    const command = steps[fetchIndex].run
    expect(command).toContain('https://github.com/stablyai/orca.git')
    for (const name of ['orca-cli', 'orchestration']) {
      const current = manifest.skills.find((entry) => entry.name === name)
      const historical = mapping.releases.toReversed().find((release) => {
        const revision = release.skills[name]
        return (
          typeof revision === 'number' &&
          revision < current.releaseRevision &&
          registry.skills[name]?.some((entry) => entry.releaseRevision === revision)
        )
      })
      expect(historical).toBeDefined()
      const tag = `v${historical.appVersion}`
      expect(command).toContain(`refs/tags/${tag}:refs/tags/${tag}`)
    }
    expect(command).not.toContain('refs/tags/*')
    expect(command).not.toContain('--force')
    expect(steps[verifyIndex].run).toContain('verify-skill-update-roundtrip.mjs')
    expect(workflow.jobs.roundtrip.strategy['fail-fast']).toBe(false)
  })
})
