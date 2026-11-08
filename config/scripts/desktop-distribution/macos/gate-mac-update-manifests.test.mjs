import { describe, expect, it } from 'vitest'
import { withMinimumSystemVersion } from './gate-mac-update-manifests.mjs'

describe('withMinimumSystemVersion', () => {
  it('replaces any earlier gate with exactly one top-level entry', () => {
    const manifest =
      'version: 1.5.0\nfiles:\n  - url: Orca-1.5.0-mac.zip\nminimumSystemVersion: 21.0.0\n'
    expect(withMinimumSystemVersion(manifest, '22.0.0')).toBe(
      'version: 1.5.0\nfiles:\n  - url: Orca-1.5.0-mac.zip\nminimumSystemVersion: 22.0.0\n'
    )
  })
})
