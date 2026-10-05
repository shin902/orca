export type BackgroundMode = 'solid' | 'image' | 'transparent'

export type DesktopBackgroundSettings = {
  backgroundMode?: BackgroundMode
  backgroundOpacity?: number
}

export type DesktopBackground = {
  wallpaper: string | null
  enabled: boolean
  status: 'connecting' | 'connected' | 'unavailable' | 'off'
  nativeTransparency: boolean
}

export const DEFAULT_DESKTOP_BACKGROUND: DesktopBackground = {
  wallpaper: null,
  enabled: true,
  status: 'off',
  nativeTransparency: false
}

export function resolveBackgroundMode(value: unknown): BackgroundMode {
  return value === 'image' || value === 'transparent' ? value : 'solid'
}

export function resolveBackgroundOpacity(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.min(1, Math.max(0, value))
    : 0.78
}

type DesktopBackgroundUpdate = {
  backgroundMode?: unknown
  backgroundOpacity?: unknown
}

export function normalizeDesktopBackgroundUpdate(update: DesktopBackgroundUpdate) {
  return {
    ...('backgroundMode' in update
      ? { backgroundMode: resolveBackgroundMode(update.backgroundMode) }
      : {}),
    ...('backgroundOpacity' in update
      ? { backgroundOpacity: resolveBackgroundOpacity(update.backgroundOpacity) }
      : {})
  }
}

export function resolveTerminalBackgroundOpacity(settings: {
  backgroundMode?: BackgroundMode
  terminalBackgroundOpacity?: number
}): number {
  return (
    settings.terminalBackgroundOpacity ??
    (resolveBackgroundMode(settings.backgroundMode) === 'solid' ? 1 : 0.78)
  )
}
