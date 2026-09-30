// @vitest-environment happy-dom
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DesktopBackground as BackgroundSnapshot } from '../../../shared/desktop-background'
import { DesktopBackground } from './DesktopBackground'

const state = vi.hoisted(() => ({ settings: { backgroundMode: 'solid', backgroundOpacity: 0.6 } }))
const background = vi.hoisted((): BackgroundSnapshot => ({
  wallpaper: 'data:image/png;base64,dGVzdA==',
  enabled: true,
  status: 'connected',
  nativeTransparency: false
}))
vi.mock('../store', () => ({
  useAppStore: (select: (value: typeof state) => unknown) => select(state)
}))
vi.mock('./use-desktop-background', () => ({ useDesktopBackground: () => background }))
afterEach(() => {
  cleanup()
  state.settings.backgroundMode = 'solid'
  background.enabled = true
  background.nativeTransparency = false
  background.wallpaper = 'data:image/png;base64,dGVzdA=='
})

describe('desktop background layer', () => {
  it('switches between wallpaper and solid immediately, and respects daemon off/on', () => {
    state.settings.backgroundMode = 'image'
    const view = render(<DesktopBackground />)
    expect(document.documentElement.hasAttribute('data-desktop-background')).toBe(true)
    expect(
      view.container.querySelector<HTMLElement>('.desktop-background')?.style.backgroundImage
    ).toContain('data:image/png')
    expect(
      view.container.querySelector<HTMLElement>('.desktop-background-shade')?.style.opacity
    ).toBe('0.6')
    background.enabled = false
    view.rerender(<DesktopBackground />)
    expect(view.container.childElementCount).toBe(0)
    expect(document.documentElement.hasAttribute('data-desktop-background')).toBe(false)
    background.enabled = true
    view.rerender(<DesktopBackground />)
    expect(view.container.childElementCount).toBe(1)
    state.settings.backgroundMode = 'solid'
    view.rerender(<DesktopBackground />)
    expect(view.container.childElementCount).toBe(0)
    expect(document.documentElement.hasAttribute('data-desktop-background')).toBe(false)
  })

  it('never pretends to show OS transparency before the native window supports it', () => {
    state.settings.backgroundMode = 'transparent'
    const view = render(<DesktopBackground />)
    expect(view.container.childElementCount).toBe(0)
    background.nativeTransparency = true
    view.rerender(<DesktopBackground />)
    expect(
      view.container.querySelector<HTMLElement>('.desktop-background')?.style.backgroundImage
    ).toBe('')
    expect(document.documentElement.hasAttribute('data-desktop-background')).toBe(true)
  })

  it('falls back to solid until an image is available and removes document styling on unmount', () => {
    state.settings.backgroundMode = 'image'
    background.wallpaper = null
    const view = render(<DesktopBackground />)
    expect(view.container.childElementCount).toBe(0)
    view.unmount()
    expect(document.documentElement.hasAttribute('data-desktop-background')).toBe(false)
  })
})
