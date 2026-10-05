import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { describe, expect, it } from 'vitest'

const repoRoot = path.resolve(import.meta.dirname, '..', '..')
const script = path.join(repoRoot, 'config', 'scripts', 'check-react-doctor-changed.mjs')

function runWithBase(base) {
  return spawnSync(process.execPath, [script, base], {
    cwd: repoRoot,
    encoding: 'utf8',
    windowsHide: true
  })
}

describe('check-react-doctor-changed diff base', () => {
  it('keeps the separately validated cloud project outside the root quality gate', () => {
    const rootLint = JSON.parse(readFileSync(path.join(repoRoot, '.oxlintrc.json'), 'utf8'))
    const manifest = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8'))
    expect(rootLint.ignorePatterns).toContain('cloud/**')
    expect(manifest.reactDoctor.ignore.files ?? []).toContain('cloud/**')
  })

  // The pnpm invocation can still fall back to a shell, so an unvalidated base
  // would reach cmd.exe unquoted. Rejection has to happen before the spawn.
  it.each(['main & calc', 'main | whoami', 'main"x', '%PATH%', 'main $(id)'])(
    'refuses %j',
    (base) => {
      const result = runWithBase(base)

      expect(result.status).not.toBe(0)
      expect(result.stderr).toContain('Refusing to pass an unsafe diff base')
    }
  )
})
