/**
 * The HTTP proxy behind the `allowlist` network policy. Confined processes cannot open connections of their
 * own; their HTTP and HTTPS traffic reaches this proxy through the standard proxy variables, and the proxy
 * connects only to allowed hosts. HTTPS goes through `CONNECT` tunnels, so the proxy sees the host name and
 * port but never the encrypted content. Refused requests get HTTP 403 with a reason a person or model can
 * read.
 *
 * @module @deepseek-ai/dsh-sandbox-local/network-proxy
 */

import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { connect, isIP, type Socket } from 'node:net'

/** A DNS name after canonicalization: non-empty labels of letters, digits, `-` and `_`. */
const DNS_NAME = /^[a-z0-9_]([a-z0-9_-]*[a-z0-9_])?(\.[a-z0-9_]([a-z0-9_-]*[a-z0-9_])?)*$/

/** A host as the proxy compares and connects to it. */
export interface CanonicalHost {
  /** The canonical spelling: a lower-case DNS name without a trailing dot, a dotted IPv4 address, or an IPv6 address without brackets. */
  readonly host: string
  /** 0 for a DNS name, else the IP version. An IPv4-mapped IPv6 address is reported as its IPv4 address. */
  readonly ip: 0 | 4 | 6
}

/**
 * Canonicalize one host the way the connection will see it, or undefined when it is not a plain DNS name or
 * IP literal. WHATWG host parsing turns every IPv4 spelling (`127.1`, `0x7f.0.0.1`) into dotted form, IDN
 * names into punycode, and IPv6 into its compressed form; an IPv4-mapped IPv6 address becomes the IPv4
 * address it reaches. Anything with `%` (a zone suffix such as `[::1%.github.com]`, or percent-encoding) is
 * refused outright, so the text checked is always the address connected to.
 * @param raw - the host as a request names it, with or without IPv6 brackets.
 * @returns the canonical host, or undefined when it is malformed.
 */
export function canonicalHost(raw: string): CanonicalHost | undefined {
  if (raw === '' || /[%\s/\\@?#]/.test(raw)) return undefined
  const bracketed = raw.startsWith('[') || raw.endsWith(']')
  if (bracketed && !(raw.startsWith('[') && raw.endsWith(']'))) return undefined
  const inner = bracketed ? raw.slice(1, -1) : raw
  if (!bracketed && inner.includes(':')) {
    // A bare IPv6 address, as an allowlist entry or `URL.hostname` may spell it.
    if (isIP(inner) !== 6) return undefined
  } else if (bracketed && isIP(inner) !== 6) {
    return undefined
  }
  let hostname: string
  try {
    hostname = new URL(`http://${isIP(inner) === 6 ? `[${inner}]` : inner}/`).hostname
  } catch {
    return undefined
  }
  if (hostname.startsWith('[')) {
    const v6 = hostname.slice(1, -1)
    const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(v6)
    if (mapped !== null) {
      const hi = Number.parseInt(mapped[1] ?? '0', 16)
      const lo = Number.parseInt(mapped[2] ?? '0', 16)
      return { host: [hi >> 8, hi & 255, lo >> 8, lo & 255].join('.'), ip: 4 }
    }
    return { host: v6, ip: 6 }
  }
  if (isIP(hostname) === 4) return { host: hostname, ip: 4 }
  const name = hostname.endsWith('.') ? hostname.slice(0, -1) : hostname
  return DNS_NAME.test(name) ? { host: name, ip: 0 } : undefined
}

/**
 * Whether an allowlist admits a host. `example.com` admits exactly that name; `*.example.com` admits its
 * subdomains (not the bare name). Both sides are canonicalized ({@link canonicalHost}), so case, a trailing
 * dot, IDN spellings and IPv6 brackets do not matter. An IP literal (IPv4, IPv6, or IPv4-mapped IPv6) matches
 * only an entry naming the same address, never a name or a wildcard; a malformed host matches nothing.
 * @param host - the host a request names.
 * @param hosts - normalized allowlist entries.
 * @returns whether the proxy may connect.
 */
export function hostAllowed(host: string, hosts: readonly string[]): boolean {
  const target = canonicalHost(host)
  if (target === undefined) return false
  return hosts.some((entry) => {
    if (target.ip === 0 && entry.startsWith('*.')) {
      const suffix = canonicalHost(entry.slice(2))
      return suffix !== undefined && suffix.ip === 0 && target.host.endsWith(`.${suffix.host}`)
    }
    const exact = canonicalHost(entry)
    return exact !== undefined && exact.ip === target.ip && exact.host === target.host
  })
}

/** A checked connection target: the canonical host to connect to, and its port. */
export interface ProxyTarget extends CanonicalHost {
  readonly port: number
}

/**
 * Split `host:port` (with an optional bracketed IPv6 host) into a canonical target, or undefined when the
 * host is malformed ({@link canonicalHost}) or the port is empty, zero or above 65535.
 * @param authority - the `CONNECT` request target, such as `example.com:443` or `[::1]:80`.
 * @param defaultPort - the port when the authority names none.
 * @returns the target, or undefined.
 */
export function splitAuthority(authority: string, defaultPort: number): ProxyTarget | undefined {
  const match = /^(\[[^\]]*\]|[^:[\]]+)(?::(\d{1,5}))?$/.exec(authority)
  if (match === null) return undefined
  const port = match[2] === undefined ? defaultPort : Number(match[2])
  if (!(port > 0 && port < 65536)) return undefined
  const host = canonicalHost(match[1] ?? '')
  return host === undefined ? undefined : { ...host, port }
}

/** The `Host` header value for a target: brackets around IPv6, and the port unless it is the default. */
function hostHeader(target: ProxyTarget, defaultPort: number): string {
  const host = target.ip === 6 ? `[${target.host}]` : target.host
  return target.port === defaultPort ? host : `${host}:${target.port}`
}

const refusal = (host: string): string =>
  `Harness Studio blocked network access to ${host}: it is not in the allowed sites for commands. `
  + 'Add it in Settings → General → Network for commands, or ask the user to approve this command with full access.\n'

/** A running proxy and how confined processes reach it. */
export interface NetworkProxy {
  /** Where it listens: a loopback TCP port, or a Unix socket path. */
  readonly address: { readonly port: number } | { readonly socketPath: string }
  /** Stop accepting connections and end the open ones. */
  close(): Promise<void>
}

/**
 * Start a proxy for one allowlist.
 * @param hosts - normalized allowlist entries.
 * @param listen - `{ port: 0 }` for a loopback TCP port chosen by the system, or `{ socketPath }`.
 * @returns the running proxy.
 */
export async function startNetworkProxy(hosts: readonly string[], listen: { port: 0 } | { socketPath: string }): Promise<NetworkProxy> {
  const sockets = new Set<Socket>()
  const track = (socket: Socket): Socket => {
    sockets.add(socket)
    socket.once('close', () => sockets.delete(socket))
    return socket
  }

  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    // A plain-HTTP proxy request carries an absolute URL.
    let target: URL
    try {
      target = new URL(req.url ?? '')
    } catch {
      res.writeHead(400, { 'content-type': 'text/plain' }).end('Expected an absolute http:// URL.\n')
      return
    }
    if (target.protocol !== 'http:') {
      res.writeHead(400, { 'content-type': 'text/plain' }).end('Only http:// requests are proxied directly; HTTPS uses CONNECT.\n')
      return
    }
    const checked = splitAuthority(target.host, 80)
    if (checked === undefined) {
      res.writeHead(400, { 'content-type': 'text/plain' }).end('Expected an absolute http:// URL with a valid host and port.\n')
      return
    }
    if (!hostAllowed(checked.host, hosts)) {
      res.writeHead(403, { 'content-type': 'text/plain' }).end(refusal(checked.host))
      return
    }
    const headers = { ...req.headers }
    delete headers['proxy-connection']
    delete headers['proxy-authorization']
    // The Host header names the checked target, never what the client sent: a request to an allowed host
    // must not carry another site's name for a shared front end (CDN domain fronting) to route by.
    headers.host = hostHeader(checked, 80)
    const upstream = httpRequest({
      host: checked.host,
      port: checked.port,
      method: req.method,
      path: `${target.pathname}${target.search}`,
      headers,
    }, (response) => {
      res.writeHead(response.statusCode ?? 502, response.headers)
      response.pipe(res)
    })
    upstream.on('error', (error) => {
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' })
      res.end(`Could not reach ${checked.host}: ${error.message}\n`)
    })
    req.pipe(upstream)
  })

  server.on('connect', (req: IncomingMessage, client: Socket, head: Buffer) => {
    track(client)
    client.on('error', () => client.destroy())
    const authority = splitAuthority(req.url ?? '', 443)
    if (authority === undefined) {
      client.end('HTTP/1.1 400 Bad Request\r\ncontent-type: text/plain\r\n\r\nExpected host:port with a valid host and port.\n')
      return
    }
    if (!hostAllowed(authority.host, hosts)) {
      const body = refusal(authority.host)
      client.end(`HTTP/1.1 403 Forbidden\r\ncontent-type: text/plain\r\ncontent-length: ${Buffer.byteLength(body)}\r\n\r\n${body}`)
      return
    }
    const upstream = track(connect(authority.port, authority.host, () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      if (head.length > 0) upstream.write(head)
      upstream.pipe(client)
      client.pipe(upstream)
    }))
    upstream.on('error', (error) => {
      if (!client.destroyed) client.end(`HTTP/1.1 502 Bad Gateway\r\ncontent-type: text/plain\r\n\r\nCould not reach ${authority.host}: ${error.message}\n`)
    })
  })
  server.on('connection', socket => { track(socket) })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    if ('socketPath' in listen) server.listen(listen.socketPath, resolve)
    else server.listen(0, '127.0.0.1', resolve)
  })
  const bound = server.address()
  const address = typeof bound === 'string' ? { socketPath: bound } : { port: bound?.port ?? 0 }
  return {
    address,
    close: () => new Promise<void>((resolve) => {
      for (const socket of sockets) socket.destroy()
      server.close(() => resolve())
    }),
  }
}

/**
 * Environment assignments that send a process's HTTP and HTTPS traffic to a proxy on the loopback
 * interface, in the spellings common tools read (curl reads only the lower-case `http_proxy`; Node reads
 * the variables when `NODE_USE_ENV_PROXY` is set).
 * @param port - the proxy's loopback port as the process sees it.
 * @returns `NAME=value` strings.
 */
export function proxyEnvironment(port: number): string[] {
  const url = `http://127.0.0.1:${port}`
  return [
    `HTTP_PROXY=${url}`, `HTTPS_PROXY=${url}`, `http_proxy=${url}`, `https_proxy=${url}`,
    'NO_PROXY=localhost,127.0.0.1,::1', 'no_proxy=localhost,127.0.0.1,::1', 'NODE_USE_ENV_PROXY=1',
  ]
}

/**
 * Source of the bridge a bwrap-confined process runs under for `allowlist` (Node's `-e`): inside the
 * process's own network namespace it listens on loopback at the given port and forwards each connection to
 * the proxy's Unix socket, which is the only way out of the namespace; then it runs the command with the
 * proxy variables set and exits with its status. Arguments: socket path, port, then the command argv.
 */
export const BRIDGE_SOURCE = [
  "const net=require('node:net'),cp=require('node:child_process');",
  'const [sock,port,...cmd]=process.argv.slice(1);',
  "const server=net.createServer(c=>{const u=net.connect(sock);c.pipe(u);u.pipe(c);c.on('error',()=>u.destroy());u.on('error',()=>c.destroy())});",
  "server.on('error',e=>{process.stderr.write('harness-network-bridge: '+e.message+'\\n');process.exit(126)});",
  "server.listen(Number(port),'127.0.0.1',()=>{",
  'const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;',
  "const child=cp.spawn(cmd[0],cmd.slice(1),{stdio:'inherit',env});",
  "for(const s of ['SIGINT','SIGTERM','SIGHUP'])process.on(s,()=>child.kill(s));",
  "child.on('error',e=>{process.stderr.write('harness-network-bridge: '+e.message+'\\n');process.exit(127)});",
  "child.on('exit',(code,signal)=>{server.close();if(signal){process.removeAllListeners(signal);process.kill(process.pid,signal)}else process.exit(code??1)})",
  '})',
].join('')
