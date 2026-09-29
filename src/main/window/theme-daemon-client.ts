import WebSocket from 'ws'
import { z } from 'zod'
import type { DesktopBackground } from '../../shared/desktop-background'

const ORIGIN = 'http://127.0.0.1:17321'
const themeResponseSchema = z.object({
  theme: z.object({ revision: z.number().finite(), wallpaperUrl: z.string() }).nullable()
})
const eventSchema = z.object({ type: z.string(), enabled: z.boolean().optional() })
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp'])

type ThemeUpdate = Partial<Pick<DesktopBackground, 'wallpaper' | 'enabled' | 'status'>>

async function fetchBytes(
  path: string,
  limit: number,
  signal: AbortSignal
): Promise<{
  bytes: Buffer
  contentType: string
}> {
  const url = new URL(path, ORIGIN)
  if (url.origin !== ORIGIN || url.username || url.password) {
    throw new Error('Wallpaper must come from the local theme daemon')
  }
  // Node fetch deliberately bypasses Chromium's browser/proxy session for this loopback-only service.
  const response = await fetch(url, {
    signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
    redirect: 'error'
  })
  const reader = response.body?.getReader()
  try {
    if (!response.ok || !reader) {
      throw new Error('Theme daemon request failed')
    }
    const chunks: Uint8Array[] = []
    let size = 0
    while (true) {
      const { done, value } = await reader.read()
      if (done) {
        break
      }
      size += value.byteLength
      if (size > limit) {
        throw new Error('Theme daemon response is too large')
      }
      chunks.push(value)
    }
    return {
      bytes: Buffer.concat(chunks),
      contentType: response.headers.get('content-type')?.split(';')[0].trim().toLowerCase() ?? ''
    }
  } finally {
    await reader?.cancel().catch(() => {})
    reader?.releaseLock()
  }
}

export function connectThemeDaemon(publish: (update: ThemeUpdate) => void): () => void {
  const abort = new AbortController()
  let socket: WebSocket | undefined
  let reconnect: ReturnType<typeof setTimeout> | undefined
  let heartbeat: ReturnType<typeof setInterval> | undefined
  let lastRevision: number | undefined
  let syncing = false
  let pending = false

  const syncWallpaper = async (): Promise<void> => {
    pending = true
    if (syncing) {
      return
    }
    syncing = true
    try {
      while (pending && !abort.signal.aborted) {
        pending = false
        const response = await fetchBytes('/v1/theme', 64 * 1024, abort.signal)
        const { theme } = themeResponseSchema.parse(JSON.parse(response.bytes.toString('utf8')))
        if (!theme) {
          lastRevision = undefined
          publish({ wallpaper: null, status: 'connected' })
          continue
        }
        if (theme.revision === lastRevision) {
          publish({ status: 'connected' })
          continue
        }
        const image = await fetchBytes(theme.wallpaperUrl, 20 * 1024 * 1024, abort.signal)
        if (!IMAGE_TYPES.has(image.contentType)) {
          throw new Error('Unsupported wallpaper type')
        }
        if (abort.signal.aborted) {
          return
        }
        publish({
          wallpaper: `data:${image.contentType};base64,${image.bytes.toString('base64')}`,
          status: 'connected'
        })
        lastRevision = theme.revision
      }
    } catch {
      if (!abort.signal.aborted) {
        publish({ status: 'unavailable' })
      }
    } finally {
      syncing = false
    }
  }

  const connect = (): void => {
    publish({ status: 'connecting' })
    socket = new WebSocket('ws://127.0.0.1:17321/v1/events', {
      handshakeTimeout: 10_000,
      maxPayload: 64 * 1024,
      followRedirects: false
    })
    let received = true
    socket.on('open', () => {
      publish({ status: 'connected' })
      // Reconcile after reconnect even when the daemon restarts its revision counter.
      lastRevision = undefined
      void syncWallpaper()
      heartbeat = setInterval(() => {
        if (!received) {
          socket?.terminate()
          return
        }
        received = false
        socket?.send('ping')
        void syncWallpaper()
      }, 20_000)
    })
    socket.on('message', (payload) => {
      received = true
      try {
        const event = eventSchema.parse(JSON.parse(payload.toString()))
        if (['ready', 'wallpaper_changed', 'theme_changed'].includes(event.type)) {
          void syncWallpaper()
        } else if (event.type === 'wallpaper_transparency_changed' && event.enabled !== undefined) {
          publish({ enabled: event.enabled })
        }
      } catch {
        // Ignore malformed events; they must not change the last usable appearance.
      }
    })
    socket.on('error', () => socket?.terminate())
    socket.on('close', () => {
      clearInterval(heartbeat)
      if (!abort.signal.aborted) {
        publish({ status: 'unavailable' })
        reconnect = setTimeout(connect, 5_000)
      }
    })
  }
  connect()
  return () => {
    abort.abort()
    clearTimeout(reconnect)
    clearInterval(heartbeat)
    socket?.terminate()
  }
}
