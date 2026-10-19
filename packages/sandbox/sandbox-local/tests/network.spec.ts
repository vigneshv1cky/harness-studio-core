/**
 * Network policy in the local backend: the profile dialects, failing closed where a runner cannot limit
 * network access, the `allowlist` argv on each runner, and the proxy itself against a loopback server.
 */

import { createServer, request, type Server } from 'node:http'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { SANDBOX_UNAVAILABLE, SandboxNetworkUnavailableError } from '@deepseek-ai/dsh-sandbox'
import type { SandboxPolicy } from '@deepseek-ai/dsh-sandbox'
import { LocalSandboxProvider, hostAllowed } from '@deepseek-ai/dsh-sandbox-local'
import { BRIDGE_SOURCE, canonicalHost, proxyEnvironment, splitAuthority, startNetworkProxy, type NetworkProxy } from '../src/network-proxy.ts'
import { bwrapProfileArgs, seatbeltProfileArgs } from '../src/profiles.ts'

const OFF: SandboxPolicy = { mode: 'workspace-write', workspaceRoot: '/ws', network: { mode: 'off' } }
const ON: SandboxPolicy = { mode: 'workspace-write', workspaceRoot: '/ws', network: { mode: 'on' } }
const LIST: SandboxPolicy = { mode: 'workspace-write', workspaceRoot: '/ws', network: { mode: 'allowlist', hosts: ['registry.npmjs.org', '*.github.com'] } }

const closers: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of closers.splice(0)) await close() })

async function provider(internals: LocalSandboxProvider['internals']) {
  const ctx = new Context()
  await ctx.plugin(LocalSandboxProvider, {})
  const sandbox = ctx.sandbox as LocalSandboxProvider
  sandbox.internals = internals
  closers.push(() => ctx.fiber.dispose())
  return sandbox
}

describe('extra writable folders', () => {
  it('bwrap binds existing extra folders writable in workspace-write only; seatbelt allows writes under them', () => {
    const extra = tmpdir()
    const args = bwrapProfileArgs({ mode: 'workspace-write', workspaceRoot: '/ws', extraWritable: [extra, '/no/such/folder'] })
    expect(args.join(' ')).toContain(`--bind ${extra} ${extra}`)
    expect(args.join(' ')).not.toContain('/no/such/folder')
    expect(bwrapProfileArgs({ mode: 'read-only', workspaceRoot: '/ws', extraWritable: [extra] }).join(' ')).not.toContain(`--bind ${extra}`)
    expect(seatbeltProfileArgs({ mode: 'workspace-write', workspaceRoot: '/ws', extraWritable: ['/ws-login'] })[1]).toContain('(subpath "/ws-login")')
  })
})

describe('network profile dialects', () => {
  it('bwrap gives a limited command a network namespace of its own, and leaves `on` alone', () => {
    expect(bwrapProfileArgs(OFF)).toContain('--unshare-net')
    expect(bwrapProfileArgs(LIST)).toContain('--unshare-net')
    expect(bwrapProfileArgs(ON)).not.toContain('--unshare-net')
    expect(bwrapProfileArgs({ mode: 'read-only', workspaceRoot: '/ws' })).not.toContain('--unshare-net')
  })

  it('seatbelt denies outbound IP connections except to loopback', () => {
    const profile = seatbeltProfileArgs(OFF)[1] as string
    expect(profile).toContain('(deny network-outbound (remote ip "*:*")) (allow network-outbound (remote ip "localhost:*"))')
    expect(seatbeltProfileArgs(ON)[1]).not.toContain('network')
  })
})

describe('confining with a network policy', () => {
  it('fails closed on Landlock, which cannot limit network access, and still runs `on` there', async () => {
    const sandbox = await provider({ platform: 'linux', probeBwrap: () => false, probeLandlock: () => 'full', landlockLauncher: '/fake/landlock-run' })
    const error = await sandbox.confine(['true'], OFF).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(SandboxNetworkUnavailableError)
    expect((error as SandboxNetworkUnavailableError).code).toBe(SANDBOX_UNAVAILABLE)
    expect((error as Error).message).toMatch(/Install bubblewrap/)
    expect((await sandbox.confine(['true'], ON)).argv[0]).toBe('/fake/landlock-run')
  })

  it('points a Seatbelt command at a loopback proxy under `allowlist`', async () => {
    const sandbox = await provider({ platform: 'darwin' })
    const confined = await sandbox.confine(['curl', 'https://registry.npmjs.org'], LIST)
    const separator = confined.argv.indexOf('--')
    const command = confined.argv.slice(separator + 1)
    expect(command[0]).toBe('/usr/bin/env')
    const port = Number(/HTTPS_PROXY=http:\/\/127\.0\.0\.1:(\d+)/.exec(command.join(' '))?.[1])
    expect(port).toBeGreaterThan(0)
    expect(command.slice(-2)).toEqual(['curl', 'https://registry.npmjs.org'])
    // The same host list reuses one proxy.
    const again = await sandbox.confine(['true'], LIST)
    expect(again.argv.join(' ')).toContain(`127.0.0.1:${port}`)
  })

  it('runs a bwrap command under the bridge to a Unix-socket proxy under `allowlist`', async () => {
    const sandbox = await provider({ platform: 'linux', probeBwrap: () => true })
    const confined = await sandbox.confine(['curl', 'https://registry.npmjs.org'], LIST)
    expect(confined.argv[0]).toBe('bwrap')
    expect(confined.argv).toContain('--unshare-net')
    const command = confined.argv.slice(confined.argv.indexOf('--') + 1)
    expect(command.slice(0, 2)).toEqual(['/usr/bin/env', 'ELECTRON_RUN_AS_NODE=1'])
    expect(command).toContain(BRIDGE_SOURCE)
    expect(command).toContain('HTTPS_PROXY=http://127.0.0.1:3128')
    const socketPath = command[command.indexOf(BRIDGE_SOURCE) + 1] as string
    expect(socketPath).toMatch(/dsh-net-[0-9a-f]{16}\.sock$/)
    expect(command.slice(-2)).toEqual(['curl', 'https://registry.npmjs.org'])
  })

  it('binds an AppImage mount back inside bwrap, since workspace-write hides /tmp and the bridge runs the app binary', async () => {
    const sandbox = await provider({ platform: 'linux', probeBwrap: () => true })
    const execPath = process.execPath
    const appDir = process.env.APPDIR
    try {
      process.env.APPDIR = '/tmp/.mount_HarnessTest'
      process.execPath = '/tmp/.mount_HarnessTest/harness-studio'
      const confined = await sandbox.confine(['true'], LIST)
      const runner = confined.argv.slice(0, confined.argv.indexOf('--'))
      const bind = runner.indexOf('/tmp/.mount_HarnessTest')
      expect(runner.slice(bind - 1, bind + 2)).toEqual(['--ro-bind', '/tmp/.mount_HarnessTest', '/tmp/.mount_HarnessTest'])
      expect(bind).toBeGreaterThan(runner.indexOf('/tmp'))
      // Not needed outside allowlist, nor when the binary lives elsewhere.
      expect((await sandbox.confine(['true'], OFF)).argv).not.toContain('/tmp/.mount_HarnessTest')
      delete process.env.APPDIR
      process.execPath = '/usr/lib/harness-studio/harness-studio'
      expect((await sandbox.confine(['true'], LIST)).argv).not.toContain('/usr/lib/harness-studio')
    } finally {
      process.execPath = execPath
      if (appDir === undefined) delete process.env.APPDIR
      else process.env.APPDIR = appDir
    }
  })

  it('closes a proxy as soon as the policy stops naming its host list', async () => {
    const sandbox = await provider({ platform: 'darwin' })
    const portOf = (argv: readonly string[]) => Number(/HTTPS_PROXY=http:\/\/127\.0\.0\.1:(\d+)/.exec(argv.join(' '))?.[1])
    const reachable = (port: number) => new Promise<boolean>((resolve) => {
      const socket = connect(port, '127.0.0.1', () => { socket.destroy(); resolve(true) })
      socket.on('error', () => resolve(false))
    })
    const settle = () => new Promise(resolve => setTimeout(resolve, 50))
    const first = portOf((await sandbox.confine(['true'], LIST)).argv)
    expect(await reachable(first)).toBe(true)
    const second = portOf((await sandbox.confine(['true'], { ...LIST, network: { mode: 'allowlist', hosts: ['pypi.org'] } })).argv)
    expect(second).not.toBe(first)
    await settle()
    expect(await reachable(first)).toBe(false)
    expect(await reachable(second)).toBe(true)
    await sandbox.confine(['true'], OFF)
    await settle()
    expect(await reachable(second)).toBe(false)
  })
})

describe('allowlist matching', () => {
  it('admits exact names and, with *., subdomains only', () => {
    const hosts = ['registry.npmjs.org', '*.github.com', '10.0.0.5']
    expect(hostAllowed('registry.npmjs.org', hosts)).toBe(true)
    expect(hostAllowed('Registry.NPMJS.org.', hosts)).toBe(true)
    expect(hostAllowed('evil-registry.npmjs.org', hosts)).toBe(false)
    expect(hostAllowed('api.github.com', hosts)).toBe(true)
    expect(hostAllowed('github.com', hosts)).toBe(false)
    expect(hostAllowed('notgithub.com', hosts)).toBe(false)
    expect(hostAllowed('10.0.0.5', hosts)).toBe(true)
    expect(hostAllowed('example.com', hosts)).toBe(false)
    expect(hostAllowed('xn--bcher-kva.github.com', hosts)).toBe(true)
    expect(hostAllowed('bücher.github.com', hosts)).toBe(true)
  })

  it('never lets an IP literal match a name or wildcard, whatever its spelling', () => {
    const hosts = ['*.github.com', 'localhost', '10.0.0.5']
    // A zone suffix makes the text end in an allowed name while the connection goes to the address.
    expect(hostAllowed('[::1%.github.com]', hosts)).toBe(false)
    expect(hostAllowed('::1%.github.com', hosts)).toBe(false)
    expect(hostAllowed('[::ffff:127.0.0.1%.github.com]', hosts)).toBe(false)
    expect(hostAllowed('[::1]', hosts)).toBe(false)
    expect(hostAllowed('[::ffff:7f00:1]', hosts)).toBe(false)
    expect(hostAllowed('127.0.0.1', hosts)).toBe(false)
    // Other spellings of an allowed address reach it, and are allowed as that address.
    expect(hostAllowed('[::ffff:10.0.0.5]', hosts)).toBe(true)
    expect(hostAllowed('10.0.5', hosts)).toBe(true)
    expect(hostAllowed('0xa.0.0.5', hosts)).toBe(true)
    expect(hostAllowed('[::ffff:10.0.0.6]', hosts)).toBe(false)
    // Malformed hosts match nothing.
    for (const bad of ['', '.github.com', 'a..github.com', 'a%2e.github.com', 'evil.com/.github.com', 'u@x.github.com', '[x.github.com]', '*.github.com']) {
      expect(hostAllowed(bad, hosts)).toBe(false)
    }
  })

  it('canonicalizes hosts to the address the connection uses', () => {
    expect(canonicalHost('A.GitHub.com.')).toEqual({ host: 'a.github.com', ip: 0 })
    expect(canonicalHost('[::FFFF:127.0.0.1]')).toEqual({ host: '127.0.0.1', ip: 4 })
    expect(canonicalHost('[0:0::1]')).toEqual({ host: '::1', ip: 6 })
    expect(canonicalHost('127.1')).toEqual({ host: '127.0.0.1', ip: 4 })
    expect(canonicalHost('[::1%25eth0]')).toBeUndefined()
    expect(canonicalHost('1.2.3.4.5')).toBeUndefined()
  })

  it('splits authorities, including IPv6 and missing ports', () => {
    expect(splitAuthority('example.com:8443', 443)).toEqual({ host: 'example.com', ip: 0, port: 8443 })
    expect(splitAuthority('example.com', 443)).toEqual({ host: 'example.com', ip: 0, port: 443 })
    expect(splitAuthority('[::1]:80', 443)).toEqual({ host: '::1', ip: 6, port: 80 })
    expect(splitAuthority('EXAMPLE.com.:8443', 443)).toEqual({ host: 'example.com', ip: 0, port: 8443 })
    expect(splitAuthority('example.com:0', 443)).toBeUndefined()
    expect(splitAuthority('example.com:', 443)).toBeUndefined()
    expect(splitAuthority('example.com:65536', 443)).toBeUndefined()
    expect(splitAuthority(':443', 443)).toBeUndefined()
    expect(splitAuthority('[::1%.github.com]:443', 443)).toBeUndefined()
    expect(splitAuthority('a:b:c', 443)).toBeUndefined()
  })

  it('sets the proxy variables in every common spelling', () => {
    expect(proxyEnvironment(9)).toEqual(expect.arrayContaining(['http_proxy=http://127.0.0.1:9', 'HTTPS_PROXY=http://127.0.0.1:9', 'NODE_USE_ENV_PROXY=1']))
  })
})

describe('the proxy', () => {
  async function upstream(): Promise<{ server: Server; port: number }> {
    const server = createServer((req, res) => { res.end(req.url === '/host' ? `host ${req.headers.host}` : `upstream saw ${req.method} ${req.url}`) })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    closers.push(() => new Promise(resolve => server.close(() => resolve())))
    return { server, port: (server.address() as { port: number }).port }
  }
  async function proxyFor(hosts: string[]): Promise<number> {
    const proxy: NetworkProxy = await startNetworkProxy(hosts, { port: 0 })
    closers.push(() => proxy.close())
    return (proxy.address as { port: number }).port
  }
  const viaProxy = (proxyPort: number, url: string, headers: Record<string, string> = {}) =>
    new Promise<{ status: number; body: string }>((resolve, reject) => {
      request({ host: '127.0.0.1', port: proxyPort, path: url, method: 'GET', headers }, (res) => {
        let body = ''
        res.on('data', (chunk: Buffer) => { body += chunk.toString() })
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }))
      }).on('error', reject).end()
    })
  const tunnel = (proxyPort: number, authority: string) => new Promise<string>((resolve, reject) => {
    const socket = connect(proxyPort, '127.0.0.1', () => socket.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n\r\n`))
    let reply = ''
    socket.on('data', (chunk: Buffer) => { reply += chunk.toString(); if (reply.includes('\r\n\r\n')) { socket.destroy(); resolve(reply) } })
    socket.on('error', reject)
  })

  it('forwards plain HTTP to an allowed host and refuses others with a readable 403', async () => {
    const { port } = await upstream()
    const proxyPort = await proxyFor(['127.0.0.1'])
    expect(await viaProxy(proxyPort, `http://127.0.0.1:${port}/ok?x=1`)).toEqual({ status: 200, body: 'upstream saw GET /ok?x=1' })
    const refused = await viaProxy(proxyPort, 'http://example.com/')
    expect(refused.status).toBe(403)
    expect(refused.body).toMatch(/blocked network access to example\.com/)
  })

  it('sends the checked host as Host, whatever Host the client sent', async () => {
    const { port } = await upstream()
    const proxyPort = await proxyFor(['127.0.0.1'])
    expect((await viaProxy(proxyPort, `http://127.0.0.1:${port}/host`, { host: 'blocked.example' })).body).toBe(`host 127.0.0.1:${port}`)
  })

  it('refuses CONNECT to IP literals dressed as allowed names, and to bad ports', async () => {
    const proxyPort = await proxyFor(['*.github.com'])
    expect(await tunnel(proxyPort, '[::1%.github.com]:443')).toMatch(/^HTTP\/1\.1 400 Bad Request/)
    expect(await tunnel(proxyPort, '[::ffff:127.0.0.1%.github.com]:443')).toMatch(/^HTTP\/1\.1 400 Bad Request/)
    expect(await tunnel(proxyPort, '[::1]:443')).toMatch(/^HTTP\/1\.1 403 Forbidden/)
    expect(await tunnel(proxyPort, 'api.github.com:')).toMatch(/^HTTP\/1\.1 400 Bad Request/)
  })

  it('opens CONNECT tunnels only to allowed hosts', async () => {
    const { port } = await upstream()
    const proxyPort = await proxyFor(['127.0.0.1'])
    expect(await tunnel(proxyPort, `127.0.0.1:${port}`)).toMatch(/^HTTP\/1\.1 200 Connection Established/)
    expect(await tunnel(proxyPort, 'example.com:443')).toMatch(/^HTTP\/1\.1 403 Forbidden/)
  })
})
