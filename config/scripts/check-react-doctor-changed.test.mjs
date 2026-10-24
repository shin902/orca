import { spawnSync } from 'node:child_process'
import path from 'node:path'
import process from 'node:process'
import { describe, expect, it } from 'vitest'

const repoRoot = path.resolve(import.meta.dirname, '..', '..')
const script = path.join(repoRoot, 'config', 'scripts', 'check-react-doctor-changed.mjs')

function runWithBase(base, env = {}) {
  return spawnSync(process.execPath, [script, base], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: { ...process.env, ...env },
    windowsHide: true
  })
}

describe('check-react-doctor-changed diff base', () => {
  // Invalid bases must fail before installing or running a tool.
  it.each(['main & calc', 'main | whoami', 'main"x', '%PATH%', 'main $(id)', '--help'])(
    'refuses %j',
    (base) => {
      const result = runWithBase(base)

      expect(result.status).not.toBe(0)
      expect(result.stderr).toContain('Refusing to pass an unsafe diff base')
    }
  )

  it.each(['main & calc', 'main | whoami', 'main"x', '%PATH%', 'main $(id)', '--help'])(
    'refuses unsafe release baseline %j',
    (base) => {
      const result = runWithBase('HEAD', { ORCA_REACT_DOCTOR_BASE: base })
      expect(result.status).not.toBe(0)
      expect(result.stderr).toContain('Refusing to pass an unsafe diff base')
    }
  )
})
