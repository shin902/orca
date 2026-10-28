import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'

const workflow = parse(readFileSync('.github/workflows/skill-update-roundtrip.yml', 'utf8'))

describe('fork skill update roundtrip fixtures', () => {
  it('verifies stale placements against the PR commit without historical release snapshots', () => {
    const job = workflow.jobs.roundtrip
    const verifications = job.steps.filter((step) =>
      step.run?.includes('verify-skill-update-roundtrip.mjs')
    )
    expect(verifications).toHaveLength(5)
    for (const step of verifications) {
      expect(step.env.SKILL_UPDATE_SOURCE).toBe(
        '${{ github.event.pull_request.head.repo.full_name || github.repository }}'
      )
      expect(step.env.SKILL_UPDATE_REF).toBe(
        '${{ github.event.pull_request.head.sha || github.sha }}'
      )
    }
    expect(verifications.slice(0, 4).map((step) => step.run)).toEqual([
      expect.stringContaining('--autocrlf=false --shape=symlink'),
      expect.stringContaining('--autocrlf=true --shape=symlink'),
      expect.stringContaining('--autocrlf=false --shape=copy'),
      expect.stringContaining('--autocrlf=true --shape=copy')
    ])
    expect(verifications[4].run).toContain('--cli=latest')
    expect(job.steps.some((step) => step.run?.includes('git fetch'))).toBe(false)
    expect(job.strategy['fail-fast']).toBe(false)
  })
})
