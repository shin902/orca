import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { BrowserWindow, ipcMain } from 'electron'
import {
  desktopBackgroundWindowOptions,
  installDesktopBackground
} from './desktop-background-window'

vi.mock('electron', () => ({
  ipcMain: new EventEmitter(),
  BrowserWindow: class {
    webContents = { mainFrame: {}, send: vi.fn() }
    isDestroyed = () => false
  }
}))

describe('native background options', () => {
  it('only publishes to its own main frame and releases IPC listeners on disposal', () => {
    const window = new BrowserWindow()
    const dispose = installDesktopBackground(window, null, false)
    ipcMain.emit('desktop-background:subscribe', { sender: window.webContents, senderFrame: {} })
    ipcMain.emit('desktop-background:subscribe', {
      sender: {},
      senderFrame: window.webContents.mainFrame
    })
    expect(window.webContents.send).not.toHaveBeenCalled()
    const event = { sender: window.webContents, senderFrame: window.webContents.mainFrame }
    ipcMain.emit('desktop-background:subscribe', event)
    expect(window.webContents.send).toHaveBeenCalledWith('desktop-background:changed', {
      wallpaper: null,
      enabled: true,
      status: 'off',
      nativeTransparency: false
    })
    dispose()
    ipcMain.emit('desktop-background:subscribe', event)
    expect(window.webContents.send).toHaveBeenCalledTimes(1)
  })

  it('keeps solid and wallpaper windows opaque without reintroducing vibrancy', () => {
    expect(desktopBackgroundWindowOptions(undefined)).toEqual({})
    expect(desktopBackgroundWindowOptions('solid')).toEqual({})
    expect(desktopBackgroundWindowOptions('image')).toEqual({})
    expect(desktopBackgroundWindowOptions('invalid')).toEqual({})
  })

  it('only opts into native alpha compositing for transparent windows', () => {
    expect(desktopBackgroundWindowOptions('transparent')).toMatchObject({
      transparent: true,
      backgroundColor: '#00000000'
    })
    expect(desktopBackgroundWindowOptions('transparent')).not.toHaveProperty('vibrancy')
  })
})
