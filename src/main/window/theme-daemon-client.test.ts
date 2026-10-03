import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { connectThemeDaemon } from './theme-daemon-client'

const sockets = vi.hoisted(() => {
  const instances: (EventEmitter & { send: ReturnType<typeof vi.fn> })[] = []
  return instances
})
vi.mock('ws', () => ({
  default: class extends EventEmitter {
    send = vi.fn()
    terminate = vi.fn(() => this.emit('close'))
    constructor() {
      super()
      sockets.push(this)
    }
  }
}))

let stop: (() => void) | undefined
afterEach(() => {
  stop?.()
  sockets.length = 0
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

function start() {
  const publish = vi.fn()
  stop = connectThemeDaemon(publish)
  const socket = sockets.at(-1)!
  socket.emit('open')
  return { publish, socket }
}

function mockThemeFetch() {
  let revision = 1
  const fetchMock = vi.fn(async (url: URL) =>
    url.pathname === '/v1/theme'
      ? Response.json({ theme: { revision, wallpaperUrl: `/v1/wallpaper?revision=${revision}` } })
      : new Response(`image-${revision}`, { headers: { 'content-type': 'image/png' } })
  )
  vi.stubGlobal('fetch', fetchMock)
  return {
    fetchMock,
    nextRevision: () => {
      revision++
    }
  }
}

async function settle() {
  await new Promise<void>((resolve) => setImmediate(resolve))
}

describe('local theme daemon', () => {
  it('loads on connect, follows revisions and transparency events without refetching unchanged images', async () => {
    const { fetchMock, nextRevision } = mockThemeFetch()
    const { publish, socket } = start()
    await settle()
    expect(publish).toHaveBeenCalledWith({
      wallpaper: 'data:image/png;base64,aW1hZ2UtMQ==',
      status: 'connected'
    })
    socket.emit('message', Buffer.from('{"type":"ready"}'))
    await settle()
    expect(fetchMock.mock.calls.filter(([url]) => url.pathname === '/v1/wallpaper')).toHaveLength(1)
    nextRevision()
    socket.emit('message', Buffer.from('{"type":"wallpaper_changed"}'))
    await settle()
    expect(publish).toHaveBeenCalledWith({
      wallpaper: 'data:image/png;base64,aW1hZ2UtMg==',
      status: 'connected'
    })
    socket.emit('message', Buffer.from('{"type":"wallpaper_transparency_changed","enabled":false}'))
    expect(publish).toHaveBeenLastCalledWith({ enabled: false })
    socket.emit('message', Buffer.from('{"type":"wallpaper_transparency_changed","enabled":true}'))
    expect(publish).toHaveBeenLastCalledWith({ enabled: true })
    const count = publish.mock.calls.length
    socket.emit(
      'message',
      Buffer.from('{"type":"wallpaper_transparency_changed","enabled":"false"}')
    )
    socket.emit('message', Buffer.from('not json'))
    expect(publish).toHaveBeenCalledTimes(count)
  })

  it('clears a removed theme and reloads its wallpaper if the same revision returns', async () => {
    let themePresent = true
    const fetchMock = vi.fn(async (url: URL) =>
      url.pathname === '/v1/theme'
        ? Response.json({
            theme: themePresent ? { revision: 1, wallpaperUrl: '/v1/wallpaper' } : null
          })
        : new Response('wallpaper', { headers: { 'content-type': 'image/png' } })
    )
    vi.stubGlobal('fetch', fetchMock)
    const { publish, socket } = start()
    await settle()
    expect(fetchMock.mock.calls.filter(([url]) => url.pathname === '/v1/wallpaper')).toHaveLength(1)

    themePresent = false
    socket.emit('message', Buffer.from('{"type":"theme_changed"}'))
    await settle()
    expect(publish).toHaveBeenLastCalledWith({ wallpaper: null, status: 'connected' })

    themePresent = true
    socket.emit('message', Buffer.from('{"type":"wallpaper_changed"}'))
    await settle()
    expect(fetchMock.mock.calls.filter(([url]) => url.pathname === '/v1/wallpaper')).toHaveLength(2)
    expect(publish).toHaveBeenLastCalledWith({
      wallpaper: 'data:image/png;base64,d2FsbHBhcGVy',
      status: 'connected'
    })
  })

  it.each([
    'https://example.com/image.png',
    '//example.com/image.png',
    'http://user:pass@127.0.0.1:17321/image.png'
  ])('refuses wallpaper URL %s', async (wallpaperUrl) => {
    const fetchMock = vi.fn(async () => Response.json({ theme: { revision: 1, wallpaperUrl } }))
    vi.stubGlobal('fetch', fetchMock)
    const { publish } = start()
    await settle()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(publish).toHaveBeenLastCalledWith({ status: 'unavailable' })
  })

  it.each(['image/heic', 'text/html', 'image/svg+xml'])(
    'keeps the previous wallpaper on unsupported %s content',
    async (contentType) => {
      const { fetchMock, nextRevision } = mockThemeFetch()
      const { publish, socket } = start()
      await settle()
      nextRevision()
      fetchMock.mockResolvedValueOnce(
        Response.json({ theme: { revision: 2, wallpaperUrl: '/v1/wallpaper' } })
      )
      fetchMock.mockResolvedValueOnce(
        new Response('invalid', { headers: { 'content-type': contentType } })
      )
      socket.emit('message', Buffer.from('{"type":"theme_changed"}'))
      await settle()
      expect(publish).toHaveBeenLastCalledWith({ status: 'unavailable' })
      expect(publish.mock.calls.filter(([update]) => update.wallpaper)).toHaveLength(1)
    }
  )

  it('bounds image downloads and forbids HTTP redirects', async () => {
    const { fetchMock } = mockThemeFetch()
    fetchMock.mockResolvedValueOnce(
      Response.json({ theme: { revision: 1, wallpaperUrl: '/v1/wallpaper' } })
    )
    fetchMock.mockResolvedValueOnce(
      new Response(new Uint8Array(20 * 1024 * 1024 + 1), {
        headers: { 'content-type': 'image/png' }
      })
    )
    const { publish } = start()
    await settle()
    expect(publish).toHaveBeenLastCalledWith({ status: 'unavailable' })
    expect(fetchMock).toHaveBeenCalledWith(
      expect.any(URL),
      expect.objectContaining({ redirect: 'error' })
    )
  })

  it('cancels an unread error response from the daemon', async () => {
    const cancel = vi.fn()
    const response = new Response(new ReadableStream({ cancel }), { status: 503 })
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => response)
    )
    const { publish } = start()
    await settle()
    expect(publish).toHaveBeenLastCalledWith({ status: 'unavailable' })
    expect(cancel).toHaveBeenCalledOnce()
    expect(response.body?.locked).toBe(false)
  })

  it('keeps the connection after a plaintext pong replies to the 20-second ping', async () => {
    vi.useFakeTimers()
    mockThemeFetch()
    const { publish, socket } = start()
    await vi.advanceTimersByTimeAsync(20_000)
    expect(socket.send).toHaveBeenCalledWith('ping')
    socket.emit('message', Buffer.from('pong'))
    await vi.advanceTimersByTimeAsync(25_000)
    expect(sockets).toHaveLength(1)
    expect(publish).not.toHaveBeenCalledWith({ status: 'unavailable' })
  })

  it('reconnects and cancels timers and downloads when stopped', async () => {
    vi.useFakeTimers()
    mockThemeFetch()
    const { publish, socket } = start()
    await vi.advanceTimersByTimeAsync(0)
    socket.emit('close')
    expect(publish).toHaveBeenLastCalledWith({ status: 'unavailable' })
    await vi.advanceTimersByTimeAsync(5_000)
    expect(sockets).toHaveLength(2)
    stop?.()
    const count = publish.mock.calls.length
    await vi.advanceTimersByTimeAsync(60_000)
    expect(sockets).toHaveLength(2)
    expect(publish).toHaveBeenCalledTimes(count)
    expect(vi.getTimerCount()).toBe(0)
  })
})
