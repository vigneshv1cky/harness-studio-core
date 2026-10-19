/**
 * DevTools access to the Browser pane's own pages (Harness Studio patch). The product document may send an
 * allowed set of Chrome DevTools Protocol commands to a guest page it owns through a browser lease: real
 * mouse and keyboard input, screenshots, DOM and accessibility reads, script evaluation, and response bodies.
 * Console, exception and network events are kept per page, so the agent can read them after the fact. The
 * debugger attaches on the first command and detaches when the page closes. Navigation still goes through the
 * pane, whose main-process checks keep applying.
 *
 * Only pages on this computer or the local network are read: a command for any other page is refused, and the
 * debugger detaches as soon as a page starts loading, is redirected to, or commits such an address; a command
 * that lands while a page is mid-way to one re-checks the address after attaching. Sites can detect an
 * attached debugger, and a signed-in site's responses can hold account data that would reach the model.
 */
import type { WebContents } from 'electron'

/** Commands the product document may send. Everything else is refused. */
export const ALLOWED_DEVTOOLS_METHODS: ReadonlySet<string> = new Set([
  'Input.dispatchMouseEvent', 'Input.dispatchKeyEvent', 'Input.insertText', 'Input.dispatchScrollEvent',
  'Page.captureScreenshot', 'Page.getLayoutMetrics', 'Page.reload',
  'Runtime.evaluate',
  'DOM.getDocument', 'DOM.querySelector', 'DOM.querySelectorAll', 'DOM.getBoxModel', 'DOM.describeNode', 'DOM.scrollIntoViewIfNeeded', 'DOM.getOuterHTML',
  'Accessibility.getFullAXTree',
  'Network.getResponseBody',
])

/**
 * Whether a page address is on this computer or the local network: http(s) to localhost, `.localhost`,
 * `.test` or `.local` names, loopback, the unspecified address (`0.0.0.0`, which dev servers print and
 * browsers reach as this computer), IPv6 unique-local, or a private IPv4 range.
 * @param url - the page address.
 * @returns whether DevTools may read the page.
 */
export function isLocalPageUrl(url: string): boolean {
  let parsed: URL
  try { parsed = new URL(url) } catch { return false }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false
  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '')
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.test') || host.endsWith('.local')) return true
  if (host === '::1' || host === '::' || host === '0.0.0.0' || /^f[cd][0-9a-f]{2}:/.test(host)) return true
  const ip = /^(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/.exec(host)
  if (ip === null) return false
  const a = Number(ip[1])
  const b = Number(ip[2])
  return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
}

/**
 * The pseudo-command that returns buffered events with a sequence number above `since`, optionally only the
 * `kinds` named, with how many older events each group has dropped.
 */
export const EVENTS_METHOD = 'Harness.events'
const MAX_TEXT = 2000

/** The event kinds, in two groups: what the page reports, and its network activity. */
export const DEVTOOLS_EVENT_KINDS = ['console', 'exception', 'log', 'request', 'response', 'failed'] as const
export type DevtoolsEventKind = typeof DEVTOOLS_EVENT_KINDS[number]

/**
 * How many events of each kind a page keeps. Each kind has its own ring, so a busy page's network traffic
 * cannot push its console errors and exceptions out.
 */
export const MAX_EVENTS_PER_KIND: Readonly<Record<DevtoolsEventKind, number>> = {
  console: 300, exception: 300, log: 300, request: 500, response: 500, failed: 500,
}

const GROUP: Readonly<Record<DevtoolsEventKind, 'console' | 'network'>> = {
  console: 'console', exception: 'console', log: 'console', request: 'network', response: 'network', failed: 'network',
}

/** One buffered event, reduced to the fields a reader needs. */
export interface DevtoolsEvent {
  readonly seq: number
  readonly time: number
  readonly kind: DevtoolsEventKind
  readonly data: Record<string, unknown>
}

/** The {@link EVENTS_METHOD} reply. */
export interface DevtoolsEventsReply {
  readonly events: DevtoolsEvent[]
  /** The highest sequence number so far; pass it as `since` next time. */
  readonly latest: number
  /** Events evicted from full rings since the debugger attached, per group. */
  readonly dropped: { readonly console: number, readonly network: number }
}

interface Attached {
  readonly events: Record<DevtoolsEventKind, DevtoolsEvent[]>
  readonly dropped: { console: number, network: number }
  seq: number
  /** Request ids to their URL and method, so responses and failures can name them. */
  readonly requests: Map<string, { url: string, method: string }>
}

function emptyBuffers(): Record<DevtoolsEventKind, DevtoolsEvent[]> {
  return { console: [], exception: [], log: [], request: [], response: [], failed: [] }
}

const clip = (value: unknown): string => {
  const text = typeof value === 'string' ? value : JSON.stringify(value) ?? String(value)
  return text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}…` : text
}

function remoteObjectText(arg: { type?: string, value?: unknown, description?: string, unserializableValue?: string }): string {
  if (arg.value !== undefined) return clip(arg.value)
  return clip(arg.unserializableValue ?? arg.description ?? arg.type ?? '')
}

/**
 * Reduce one protocol event to a buffered record, or undefined for events nobody reads.
 * `any`: protocol event parameters are untyped JSON whose shape depends on the method.
 */
function record(state: Attached, method: string, params: Record<string, any>): Omit<DevtoolsEvent, 'seq' | 'time'> | undefined {
  switch (method) {
    case 'Runtime.consoleAPICalled':
      return { kind: 'console', data: { level: params.type, text: (params.args ?? []).map(remoteObjectText).join(' '), url: params.stackTrace?.callFrames?.[0]?.url, line: params.stackTrace?.callFrames?.[0]?.lineNumber } }
    case 'Runtime.exceptionThrown': {
      const details = params.exceptionDetails ?? {}
      const frames = (details.stackTrace?.callFrames ?? []).slice(0, 8).map((f: any) => `${f.functionName || '(anonymous)'} ${f.url}:${f.lineNumber + 1}:${f.columnNumber + 1}`)
      return { kind: 'exception', data: { text: clip(details.exception?.description ?? details.text), url: details.url, line: details.lineNumber, stack: frames } }
    }
    case 'Log.entryAdded':
      return { kind: 'log', data: { level: params.entry?.level, source: params.entry?.source, text: clip(params.entry?.text), url: params.entry?.url } }
    case 'Network.requestWillBeSent':
      state.requests.set(params.requestId, { url: params.request?.url, method: params.request?.method })
      if (state.requests.size > MAX_EVENTS_PER_KIND.request * 2) state.requests.delete(state.requests.keys().next().value as string)
      return { kind: 'request', data: { id: params.requestId, method: params.request?.method, url: clip(params.request?.url), type: params.type } }
    case 'Network.responseReceived': {
      const known = state.requests.get(params.requestId)
      return { kind: 'response', data: { id: params.requestId, method: known?.method, url: clip(params.response?.url ?? known?.url), status: params.response?.status, mimeType: params.response?.mimeType, type: params.type } }
    }
    case 'Network.loadingFailed': {
      const known = state.requests.get(params.requestId)
      return { kind: 'failed', data: { id: params.requestId, method: known?.method, url: clip(known?.url), error: params.errorText, canceled: params.canceled, blockedReason: params.blockedReason } }
    }
    default:
      return undefined
  }
}

/** Per-page debugger attachment, command forwarding and event buffers. */
export class BrowserDevtools {
  private readonly attached = new WeakMap<WebContents, Attached>()
  /** Pages whose debugger listeners are installed; they read the current state, so a re-attach reuses them. */
  private readonly listening = new WeakSet<WebContents>()

  /**
   * @param guestFor - the guest page with this id that `owner` holds a lease for, or undefined.
   */
  constructor(private readonly guestFor: (owner: WebContents, guestId: number) => WebContents | undefined) {}

  private async attach(guest: WebContents): Promise<Attached> {
    const existing = this.attached.get(guest)
    if (existing !== undefined && guest.debugger.isAttached()) return existing
    const state: Attached = { events: emptyBuffers(), dropped: { console: 0, network: 0 }, seq: existing?.seq ?? 0, requests: new Map() }
    if (!guest.debugger.isAttached()) guest.debugger.attach('1.3')
    this.attached.set(guest, state)
    if (!this.listening.has(guest)) {
      this.listening.add(guest)
      guest.debugger.on('message', (_event, method, params) => {
        const current = this.attached.get(guest)
        if (current === undefined) return
        // Protocol event parameters are untyped JSON; record() reads only the fields it names.
        const reduced = record(current, method, params as Record<string, any>)
        if (reduced === undefined) return
        const ring = current.events[reduced.kind]
        ring.push({ ...reduced, seq: ++current.seq, time: Date.now() })
        const over = ring.length - MAX_EVENTS_PER_KIND[reduced.kind]
        if (over > 0) {
          ring.splice(0, over)
          current.dropped[GROUP[reduced.kind]] += over
        }
      })
      guest.debugger.on('detach', () => { this.attached.delete(guest) })
      guest.once('destroyed', () => { this.attached.delete(guest) })
      // Leaving local addresses ends the attachment before the new page loads; a later command re-checks the address.
      const leave = (details: { url?: string, isMainFrame?: boolean, isSameDocument?: boolean } | undefined, url: string, isSameDocument: boolean, isMainFrame: boolean): void => {
        const target = details?.url ?? url
        if ((details?.isMainFrame ?? isMainFrame) && !(details?.isSameDocument ?? isSameDocument) && !isLocalPageUrl(target)) this.detach(guest)
      }
      guest.on('did-start-navigation', leave)
      guest.on('did-redirect-navigation', leave)
      // A command that landed after a navigation started (and so re-attached while the old local address was
      // still current) must not stay attached once the remote page commits.
      const committed = (url: string, isMainFrame: boolean): void => {
        if (isMainFrame && !isLocalPageUrl(url)) this.detach(guest)
      }
      guest.on('did-navigate', (_event: unknown, url: string) => { committed(url, true) })
      guest.on('did-frame-navigate', (_event: unknown, url: string, _code: number, _status: string, isMainFrame: boolean) => { committed(url, isMainFrame) })
    }
    await Promise.all(['Runtime.enable', 'Log.enable', 'Network.enable', 'Page.enable'].map(m => guest.debugger.sendCommand(m)))
    return state
  }

  /** End a page's debugger attachment and forget its buffer. */
  private detach(guest: WebContents): void {
    this.attached.delete(guest)
    if (guest.isDestroyed() || !guest.debugger.isAttached()) return
    try {
      guest.debugger.detach()
    } catch (error) {
      // The page closed or detached between the check and the call; either way nothing stays attached.
      console.warn('desktop browser devtools: detach failed', error)
    }
  }

  /**
   * Forward one command for a guest page the sender owns.
   * @param owner - the product document making the request.
   * @param request - `{ guest, method, params }`, where `guest` is the page's web contents id.
   * @returns the command's result, or a {@link DevtoolsEventsReply} for {@link EVENTS_METHOD}.
   */
  async send(owner: WebContents, request: unknown): Promise<unknown> {
    if (typeof request !== 'object' || request === null) throw new Error('desktop browser devtools: a request object is required')
    const { guest: guestId, method, params } = request as { guest?: unknown, method?: unknown, params?: unknown }
    if (typeof guestId !== 'number' || typeof method !== 'string') throw new Error('desktop browser devtools: guest and method are required')
    if (method !== EVENTS_METHOD && !ALLOWED_DEVTOOLS_METHODS.has(method)) throw new Error(`desktop browser devtools: ${method} is not allowed`)
    if (params !== undefined && (typeof params !== 'object' || params === null)) throw new Error('desktop browser devtools: params must be an object')
    const guest = this.guestFor(owner, guestId)
    if (guest === undefined || guest.isDestroyed()) throw new Error('desktop browser devtools: that page is not one of this window\'s Browser pane pages')
    if (!isLocalPageUrl(guest.getURL())) throw new Error('desktop browser devtools: only pages on this computer or the local network can be read')
    const kinds = eventKinds(method === EVENTS_METHOD ? (params as { kinds?: unknown } | undefined)?.kinds : undefined)
    const state = await this.attach(guest)
    // The page may have moved on while the debugger attached: check again, and let nothing stay attached to a remote page.
    if (guest.isDestroyed() || !isLocalPageUrl(guest.getURL())) {
      this.detach(guest)
      throw new Error('desktop browser devtools: only pages on this computer or the local network can be read')
    }
    if (method === EVENTS_METHOD) {
      const since = typeof (params as { since?: unknown } | undefined)?.since === 'number' ? (params as { since: number }).since : 0
      const events = kinds.flatMap(kind => state.events[kind].filter(event => event.seq > since)).sort((a, b) => a.seq - b.seq)
      return { events, latest: state.seq, dropped: { ...state.dropped } } satisfies DevtoolsEventsReply
    }
    return guest.debugger.sendCommand(method, params as Record<string, unknown> | undefined)
  }
}

/**
 * The kinds an {@link EVENTS_METHOD} request asks for: all of them when `kinds` is absent.
 * @param kinds - the request's `kinds` parameter.
 * @returns the kinds to return, in {@link DEVTOOLS_EVENT_KINDS} order.
 */
function eventKinds(kinds: unknown): readonly DevtoolsEventKind[] {
  if (kinds === undefined) return DEVTOOLS_EVENT_KINDS
  if (!Array.isArray(kinds) || kinds.some(kind => !(DEVTOOLS_EVENT_KINDS as readonly unknown[]).includes(kind))) {
    throw new Error(`desktop browser devtools: kinds must be an array of ${DEVTOOLS_EVENT_KINDS.join(', ')}`)
  }
  return DEVTOOLS_EVENT_KINDS.filter(kind => kinds.includes(kind))
}
