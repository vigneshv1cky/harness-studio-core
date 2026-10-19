/** The sandbox policy the SSH helper admits from its client: every field a resolved local policy can carry. */
import { describe, expect, it } from 'vitest'
import { policySchema } from '../src/schemas.ts'

describe('SSH helper policy schema', () => {
  it('admits a network policy and passes it through to the remote sandbox', () => {
    for (const network of [{ mode: 'on' }, { mode: 'off' }, { mode: 'allowlist', hosts: ['pypi.org', '*.github.com'] }] as const) {
      expect(policySchema.parse({ mode: 'workspace-write', workspaceRoot: '/w', network })).toEqual({ mode: 'workspace-write', workspaceRoot: '/w', network })
    }
  })

  it('admits the client\'s secret-file list and drops it, since its paths name the client\'s computer', () => {
    const readDeny = { paths: ['/Users/me/.ssh'], except: ['/Users/me/.ssh/known_hosts'], dotenvOutsideWorkspace: true }
    expect(policySchema.parse({ mode: 'read-only', workspaceRoot: '/w', readDeny, network: { mode: 'off' } })).toEqual({ mode: 'read-only', workspaceRoot: '/w', network: { mode: 'off' } })
    expect(() => policySchema.parse({ mode: 'read-only', workspaceRoot: '/w', readDeny: { paths: [] } })).toThrow()
  })

  it('still rejects unknown fields and malformed network policies', () => {
    expect(() => policySchema.parse({ mode: 'workspace-write', workspaceRoot: '/w', extra: true })).toThrow()
    expect(() => policySchema.parse({ mode: 'workspace-write', workspaceRoot: '/w', network: { mode: 'sideways' } })).toThrow()
    expect(() => policySchema.parse({ mode: 'workspace-write', workspaceRoot: '/w', network: { mode: 'allowlist' } })).toThrow()
  })
})
