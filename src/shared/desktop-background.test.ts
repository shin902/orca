import { describe, expect, it } from 'vitest'
import {
  normalizeDesktopBackgroundUpdate,
  resolveBackgroundMode,
  resolveBackgroundOpacity,
  resolveTerminalBackgroundOpacity
} from './desktop-background'

describe('background preferences', () => {
  it('defaults to solid and normalizes invalid opacity', () => {
    expect(normalizeDesktopBackgroundUpdate({})).toEqual({})
    expect(
      normalizeDesktopBackgroundUpdate({ backgroundMode: 'invalid', backgroundOpacity: -1 })
    ).toEqual({ backgroundMode: 'solid', backgroundOpacity: 0 })
    expect(resolveBackgroundMode(undefined)).toBe('solid')
    expect(resolveBackgroundMode('invalid')).toBe('solid')
    expect(resolveBackgroundOpacity(undefined)).toBe(0.78)
    expect(resolveBackgroundOpacity(Number.NaN)).toBe(0.78)
    expect(resolveBackgroundOpacity(2)).toBe(1)
    expect(resolveBackgroundOpacity(-1)).toBe(0)
  })
  it('uses a translucent terminal over a backdrop without overwriting explicit terminal opacity', () => {
    expect(resolveTerminalBackgroundOpacity({})).toBe(1)
    expect(resolveTerminalBackgroundOpacity({ backgroundMode: 'image' })).toBe(0.78)
    expect(resolveTerminalBackgroundOpacity({ backgroundMode: 'transparent' })).toBe(0.78)
    expect(
      resolveTerminalBackgroundOpacity({ backgroundMode: 'image', terminalBackgroundOpacity: 0.5 })
    ).toBe(0.5)
    expect(
      resolveTerminalBackgroundOpacity({ backgroundMode: 'solid', terminalBackgroundOpacity: 0.5 })
    ).toBe(0.5)
  })
})
