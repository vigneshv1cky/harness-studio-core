/** DevTools access to Browser pane pages: ownership, the allowed command list, local pages only, and buffered events. */

import { EventEmitter } from 'node:events'
import { describe, expect, it } from 'vitest'
import type { WebContents } from 'electron'
import { ALLOWED_DEVTOOLS_METHODS, BrowserDevtools, EVENTS_METHOD, MAX_EVENTS_PER_KIND, isLocalPageUrl, type DevtoolsEventsReply } from '../src/browser-devtools.ts'

function fakeGuest(id: number, url = 'http://localhost:3000/', onCommand?: (method: string) => void) {
  const debuggerEvents = new EventEmitter()
  const sent: { method: string, params?: unknown }[] = []
  let attached = false
  let current = url
  const guest = Object.assign(new EventEmitter(), {
    id,
    isDestroyed: () => false,
    getURL: () => current,
    debugger: Object.assign(debuggerEvents, {
      isAttached: () => attached,
      attach: () => { attached = true },
      detach: () => { attached = false },
      sendCommand: async (method: string, params?: unknown) => { sent.push({ method, params }); onCommand?.(method); return { ok: method } },
    }),
  })
  return {
    guest: guest as unknown as WebContents,
    sent,
    isAttached: () => attached,
    emit: (method: string, params: unknown) => debuggerEvents.emit('message', {}, method, params),
    /** Start a main-frame navigation the way Electron reports it. */
    navigate: (next: string, event = 'did-start-navigation') => {
      guest.emit(event, { url: next, isMainFrame: true, isSameDocument: false }, next, false, true)
      current = next
    },
    /** Start a main-frame navigation without committing it: the old address stays current. */
    start: (next: string) => { guest.emit('did-start-navigation', { url: next, isMainFrame: true, isSameDocument: false }, next, false, true) },
    /** Commit a main-frame navigation, as `did-navigate` and `did-frame-navigate` report it. */
    commit: (next: string, event: 'did-navigate' | 'did-frame-navigate' = 'did-navigate') => {
      current = next
      if (event === 'did-navigate') guest.emit(event, {}, next, 200, 'OK')
      else guest.emit(event, {}, next, 200, 'OK', true, 1, 1)
    },
    setURL: (next: string) => { current = next },
  }
}

describe('BrowserDevtools', () => {
  const owner = {} as WebContents
  const other = {} as WebContents

  it('forwards allowed commands only for the owner\'s own pages, attaching on first use', async () => {
    const page = fakeGuest(7)
    const devtools = new BrowserDevtools((who, id) => (who === owner && id === 7 ? page.guest : undefined))
    await expect(devtools.send(owner, { guest: 7, method: 'Page.captureScreenshot', params: { format: 'png' } })).resolves.toEqual({ ok: 'Page.captureScreenshot' })
    expect(page.sent.map(s => s.method)).toEqual(['Runtime.enable', 'Log.enable', 'Network.enable', 'Page.enable', 'Page.captureScreenshot'])
    await expect(devtools.send(other, { guest: 7, method: 'Page.captureScreenshot' })).rejects.toThrow('not one of this window')
    await expect(devtools.send(owner, { guest: 7, method: 'Page.navigate', params: { url: 'https://example.com' } })).rejects.toThrow('Page.navigate is not allowed')
    await expect(devtools.send(owner, { guest: 7, method: 'Browser.close' })).rejects.toThrow('not allowed')
    await expect(devtools.send(owner, { guest: '7', method: 'Page.reload' })).rejects.toThrow('guest and method are required')
    expect(ALLOWED_DEVTOOLS_METHODS.has('Network.getResponseBody')).toBe(true)
  })

  it('reads only pages on this computer or the local network, and detaches when a page leaves them', async () => {
    const page = fakeGuest(5, 'https://mail.example.com/')
    const devtools = new BrowserDevtools(() => page.guest)
    await expect(devtools.send(owner, { guest: 5, method: EVENTS_METHOD })).rejects.toThrow('only pages on this computer or the local network')
    expect(page.isAttached()).toBe(false)
    page.navigate('http://localhost:5173/')
    await devtools.send(owner, { guest: 5, method: EVENTS_METHOD })
    expect(page.isAttached()).toBe(true)
    page.navigate('https://accounts.example.com/login')
    expect(page.isAttached()).toBe(false)
    await expect(devtools.send(owner, { guest: 5, method: 'Network.getResponseBody', params: { requestId: '1' } })).rejects.toThrow('only pages')
    page.navigate('http://127.0.0.1:4000/')
    await devtools.send(owner, { guest: 5, method: EVENTS_METHOD })
    page.navigate('https://tracker.example.net/', 'did-redirect-navigation')
    expect(page.isAttached()).toBe(false)
  })

  it('detaches when a remote page commits after a command re-attached mid-navigation', async () => {
    for (const event of ['did-navigate', 'did-frame-navigate'] as const) {
      const page = fakeGuest(6)
      const devtools = new BrowserDevtools(() => page.guest)
      await devtools.send(owner, { guest: 6, method: EVENTS_METHOD })
      page.start('https://mail.example.com/')
      expect(page.isAttached()).toBe(false)
      // The old local address is still current, so a command now re-attaches...
      await devtools.send(owner, { guest: 6, method: 'Page.getLayoutMetrics' })
      expect(page.isAttached()).toBe(true)
      // ...and the commit of the remote page ends it.
      page.commit('https://mail.example.com/inbox', event)
      expect(page.isAttached()).toBe(false)
    }
  })

  it('re-checks the address after attaching, and refuses a command if the page left meanwhile', async () => {
    const page = fakeGuest(8, 'http://localhost:3000/', (method) => { if (method === 'Page.enable') page.setURL('https://mail.example.com/') })
    const devtools = new BrowserDevtools(() => page.guest)
    await expect(devtools.send(owner, { guest: 8, method: 'Page.captureScreenshot' })).rejects.toThrow('only pages on this computer')
    expect(page.isAttached()).toBe(false)
    expect(page.sent.map(s => s.method)).not.toContain('Page.captureScreenshot')
  })

  it('treats loopback, .localhost, .test, .local and private addresses as local, and nothing else', () => {
    for (const url of ['http://localhost:3000/', 'http://127.0.0.1/', 'http://0.0.0.0:5173/', 'http://[::1]:8080/', 'https://app.localhost/', 'http://shop.test/', 'http://mac.local/', 'http://10.1.2.3/', 'http://172.16.0.1/', 'http://192.168.1.9/']) expect(isLocalPageUrl(url)).toBe(true)
    for (const url of ['https://example.com/', 'http://localhost.example.com/', 'http://172.32.0.1/', 'http://127.0.0.1.nip.io/', 'file:///etc/hosts', 'about:blank', '']) expect(isLocalPageUrl(url)).toBe(false)
  })

  it('buffers console messages, uncaught errors and network activity, and returns those after a sequence number', async () => {
    const page = fakeGuest(3)
    const devtools = new BrowserDevtools(() => page.guest)
    await devtools.send(owner, { guest: 3, method: EVENTS_METHOD })
    page.emit('Runtime.consoleAPICalled', { type: 'error', args: [{ type: 'string', value: 'boom' }, { type: 'number', value: 42 }] })
    page.emit('Network.requestWillBeSent', { requestId: 'r1', request: { url: 'http://localhost:3000/api/items', method: 'GET' }, type: 'Fetch' })
    page.emit('Network.responseReceived', { requestId: 'r1', response: { url: 'http://localhost:3000/api/items', status: 500, mimeType: 'application/json' }, type: 'Fetch' })
    page.emit('Network.loadingFailed', { requestId: 'r2', errorText: 'net::ERR_CONNECTION_REFUSED' })
    page.emit('Runtime.exceptionThrown', { exceptionDetails: { exception: { description: 'TypeError: x is undefined' }, stackTrace: { callFrames: [{ functionName: 'render', url: 'app.js', lineNumber: 9, columnNumber: 4 }] } } })
    page.emit('Page.frameNavigated', { frame: {} })
    const all = await devtools.send(owner, { guest: 3, method: EVENTS_METHOD, params: { since: 0 } }) as { events: { seq: number, kind: string, data: Record<string, unknown> }[], latest: number, dropped: { console: number, network: number } }
    expect(all.events.map(e => e.kind)).toEqual(['console', 'request', 'response', 'failed', 'exception'])
    expect(all.events[0]!.data.text).toBe('boom 42')
    expect(all.events[2]!.data).toMatchObject({ id: 'r1', method: 'GET', status: 500 })
    expect(all.events[4]!.data.stack).toEqual(['render app.js:10:5'])
    const later = await devtools.send(owner, { guest: 3, method: EVENTS_METHOD, params: { since: all.events[2]!.seq } }) as { events: unknown[] }
    expect(later.events).toHaveLength(2)
    expect(all.dropped).toEqual({ console: 0, network: 0 })
  })

  it('keeps console errors and exceptions through heavy network traffic, counts what each group dropped, and filters by kind', async () => {
    const page = fakeGuest(4)
    const devtools = new BrowserDevtools(() => page.guest)
    await devtools.send(owner, { guest: 4, method: EVENTS_METHOD })
    page.emit('Runtime.consoleAPICalled', { type: 'error', args: [{ type: 'string', value: 'early error' }] })
    page.emit('Runtime.exceptionThrown', { exceptionDetails: { text: 'Uncaught', exception: { description: 'Error: early' } } })
    for (let i = 0; i < 2000; i += 1) {
      page.emit('Network.requestWillBeSent', { requestId: `r${i}`, request: { url: `http://localhost:3000/poll/${i}`, method: 'GET' }, type: 'XHR' })
      page.emit('Network.responseReceived', { requestId: `r${i}`, response: { url: `http://localhost:3000/poll/${i}`, status: 200 }, type: 'XHR' })
    }
    const reply = await devtools.send(owner, { guest: 4, method: EVENTS_METHOD }) as DevtoolsEventsReply
    expect(reply.events.filter(e => e.kind === 'console').map(e => e.data.text)).toEqual(['early error'])
    expect(reply.events.filter(e => e.kind === 'exception')).toHaveLength(1)
    expect(reply.events.filter(e => e.kind === 'request')).toHaveLength(MAX_EVENTS_PER_KIND.request)
    expect(reply.events.filter(e => e.kind === 'response')).toHaveLength(MAX_EVENTS_PER_KIND.response)
    expect(reply.dropped).toEqual({ console: 0, network: 2 * (2000 - 500) })
    expect(reply.events.map(e => e.seq)).toEqual([...reply.events.map(e => e.seq)].sort((a, b) => a - b))
    expect(reply.latest).toBe(2 + 4000)

    const errors = await devtools.send(owner, { guest: 4, method: EVENTS_METHOD, params: { kinds: ['console', 'exception'] } }) as DevtoolsEventsReply
    expect(errors.events.map(e => e.kind)).toEqual(['console', 'exception'])
    expect(errors.dropped).toEqual(reply.dropped)
    for (let i = 0; i < 301; i += 1) page.emit('Log.entryAdded', { entry: { level: 'info', source: 'other', text: `log ${i}` } })
    const logs = await devtools.send(owner, { guest: 4, method: EVENTS_METHOD, params: { kinds: ['log'] } }) as DevtoolsEventsReply
    expect(logs.events).toHaveLength(MAX_EVENTS_PER_KIND.log)
    expect(logs.dropped.console).toBe(1)
    await expect(devtools.send(owner, { guest: 4, method: EVENTS_METHOD, params: { kinds: 'console' } })).rejects.toThrow('kinds must be an array')
    await expect(devtools.send(owner, { guest: 4, method: EVENTS_METHOD, params: { kinds: ['console', 'cookies'] } })).rejects.toThrow('kinds must be an array')
  })
})
