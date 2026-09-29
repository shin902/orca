import { useEffect } from 'react'
import { useAppStore } from '../store'
import { useDesktopBackground } from './use-desktop-background'
import { resolveBackgroundMode, resolveBackgroundOpacity } from '../../../shared/desktop-background'
import '../assets/desktop-background.css'

export function DesktopBackground(): React.JSX.Element | null {
  const mode = useAppStore((state) => resolveBackgroundMode(state.settings?.backgroundMode))
  const opacity = useAppStore((state) =>
    resolveBackgroundOpacity(state.settings?.backgroundOpacity)
  )
  const background = useDesktopBackground()
  const active =
    background.enabled &&
    ((mode === 'image' && background.wallpaper !== null) ||
      (mode === 'transparent' && background.nativeTransparency))
  useEffect(() => {
    document.documentElement.toggleAttribute('data-desktop-background', active)
    return () => document.documentElement.removeAttribute('data-desktop-background')
  }, [active])

  if (!active) {
    return null
  }
  return (
    <div
      aria-hidden="true"
      className="desktop-background"
      style={{
        backgroundImage:
          mode === 'image' ? `url(${JSON.stringify(background.wallpaper)})` : undefined,
        backgroundColor: mode === 'image' ? 'var(--background)' : undefined
      }}
    >
      <div className="desktop-background-shade" style={{ opacity }} />
    </div>
  )
}
