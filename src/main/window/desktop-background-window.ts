import {
  ipcMain,
  type BrowserWindow,
  type BrowserWindowConstructorOptions,
  type IpcMainEvent
} from 'electron'
import type { Store } from '../persistence'
import { DEFAULT_DESKTOP_BACKGROUND, resolveBackgroundMode } from '../../shared/desktop-background'
import { connectThemeDaemon } from './theme-daemon-client'

export function desktopBackgroundWindowOptions(mode: unknown): BrowserWindowConstructorOptions {
  if (resolveBackgroundMode(mode) !== 'transparent') {
    return {}
  }
  return {
    transparent: true,
    backgroundColor: '#00000000',
    ...(process.platform === 'win32' ? { frame: false } : {})
  }
}

export function installDesktopBackground(
  window: BrowserWindow,
  store: Store | null,
  nativeTransparency: boolean
): () => void {
  let snapshot = { ...DEFAULT_DESKTOP_BACKGROUND, nativeTransparency }
  let stop: (() => void) | undefined
  let unsubscribe: (() => void) | undefined
  let subscribed = false
  const publish = (): void => {
    if (!window.isDestroyed()) {
      window.webContents.send('desktop-background:changed', snapshot)
    }
  }
  const reconcile = (): void => {
    const enabled = resolveBackgroundMode(store?.getSettings().backgroundMode) !== 'solid'
    if (enabled && !stop) {
      stop = connectThemeDaemon((update) => {
        const next = { ...snapshot, ...update }
        if (
          next.wallpaper === snapshot.wallpaper &&
          next.enabled === snapshot.enabled &&
          next.status === snapshot.status
        ) {
          return
        }
        snapshot = next
        publish()
      })
    } else if (!enabled && stop) {
      stop()
      stop = undefined
      snapshot = { ...snapshot, status: 'off' }
      publish()
    }
  }
  const subscribe = (event: IpcMainEvent): void => {
    if (event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) {
      return
    }
    if (!subscribed) {
      subscribed = true
      unsubscribe = store?.onSettingsChanged(reconcile)
      reconcile()
    }
    publish()
  }
  ipcMain.on('desktop-background:subscribe', subscribe)
  return () => {
    ipcMain.removeListener('desktop-background:subscribe', subscribe)
    unsubscribe?.()
    stop?.()
  }
}
