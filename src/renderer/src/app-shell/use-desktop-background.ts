import { useEffect, useState } from 'react'
import { DEFAULT_DESKTOP_BACKGROUND } from '../../../shared/desktop-background'

export function useDesktopBackground() {
  const [background, setBackground] = useState(DEFAULT_DESKTOP_BACKGROUND)
  useEffect(() => window.api.app.onDesktopBackground(setBackground), [])
  return background
}
