/** Session Controller in-place rewind over a real Agent loop. */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import { MockAdapter, textResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { createSessionTestRemote } from './test-remote.ts'

const sid = (id: string): SessionId => id as SessionId
const message = (text: string) => createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })

async function realAgent(replies: readonly string[]) {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  const harness = await mountAgentLoopTestHarness(ctx)
  const adapter = new MockAdapter(replies.map(reply => textResponse(reply)))
  ctx.llm.registerAdapter(['mock'], adapter)
  ctx.provide('workspaceRegistry', { list: () => [], archivedSessionIds: [] } as never)
  const agent = await harness.create(sid('rewind-source'), { provider: 'mock', model: 'mock' })
  const remote = createSessionTestRemote(ctx, {
    defaultModelSelection: () => ({ provider: 'mock', model: 'mock' }), cwd: '/tmp',
  })
  return { ctx, adapter, agent, remote }
}

const lastRequest = (adapter: MockAdapter): string => JSON.stringify(adapter.requests.at(-1)?.messages)

describe('sessions.rewind', () => {
  it('sets the model context back to before the turn in the same Session, keeping the log', async () => {
    const { ctx, adapter, agent, remote } = await realAgent(['reply one', 'reply two', 'reply edited'])
    try {
      agent.followup(message('first prompt'))
      await agent.whenIdle()
      agent.followup(message('second prompt'))
      await agent.whenIdle()
      const before = agent.session.snapshotEvents()

      const response = await remote.rewind({ sessionId: agent.id, beforeTurn: 2 })

      if (!response.ok) throw response.error
      const after = agent.session.snapshotEvents()
      expect(after.slice(0, before.length)).toEqual(before)
      expect(after.slice(before.length)).toMatchObject([{
        type: 'system/message',
        seq: response.value.seq,
        data: { turn: 2, step: 0, message: { role: 'system', content: [] } },
        surfaceOp: { op: 'replace' },
      }])
      expect(JSON.stringify(agent.session.deriveMessages())).not.toContain('second prompt')
      agent.followup(message('edited second prompt'))
      await agent.whenIdle()
      const request = lastRequest(adapter)
      expect(request).toContain('first prompt')
      expect(request).toContain('reply one')
      expect(request).toContain('edited second prompt')
      expect(request).not.toContain('"second prompt"')
      expect(request).not.toContain('reply two')
      expect(adapter.requests.at(-1)?.messages.filter(item => item.role === 'system').length)
        .toBe(adapter.requests[0]?.messages.filter(item => item.role === 'system').length)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('rewinds to the first message and twice in a row', async () => {
    const { ctx, adapter, agent, remote } = await realAgent(['one', 'two', 'three', 'four'])
    try {
      agent.followup(message('alpha'))
      await agent.whenIdle()
      agent.followup(message('beta'))
      await agent.whenIdle()

      const first = await remote.rewind({ sessionId: agent.id, beforeTurn: 2 })
      if (!first.ok) throw first.error
      agent.followup(message('gamma'))
      await agent.whenIdle()
      const second = await remote.rewind({ sessionId: agent.id, beforeTurn: 1 })
      if (!second.ok) throw second.error
      agent.followup(message('delta'))
      await agent.whenIdle()

      const request = lastRequest(adapter)
      expect(request).toContain('delta')
      for (const gone of ['alpha', 'beta', 'gamma', '"one"', '"three"']) expect(request).not.toContain(gone)
      expect(adapter.requests.at(-1)?.messages[0]?.role).toBe('system')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('refuses a missing turn, an invalid turn, and a running agent without writing', async () => {
    const { ctx, agent, remote } = await realAgent(['one'])
    try {
      agent.followup(message('alpha'))
      await agent.whenIdle()
      const length = agent.session.snapshotEvents().length

      const missing = await remote.rewind({ sessionId: agent.id, beforeTurn: 5 })
      expect(missing).toMatchObject({ ok: false, error: { code: 'session/rewind-unavailable' } })
      const invalid = await remote.rewind({ sessionId: agent.id, beforeTurn: 0 })
      expect(invalid).toMatchObject({ ok: false, error: { code: 'gateway/bad-request' } })
      Object.defineProperty(agent, 'status', { configurable: true, get: () => 'running' })
      const busy = await remote.rewind({ sessionId: agent.id, beforeTurn: 1 })
      expect(busy).toMatchObject({ ok: false, error: { code: 'session/agent-busy' } })
      expect(agent.session.snapshotEvents()).toHaveLength(length)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('drops input still queued for the rewound context', async () => {
    const { ctx, adapter, agent, remote } = await realAgent(['one', 'two', 'three'])
    try {
      agent.followup(message('alpha'))
      await agent.whenIdle()
      agent.inbox.append('next-turn', message('queued'))

      const response = await remote.rewind({ sessionId: agent.id, beforeTurn: 1 })

      if (!response.ok) throw response.error
      expect([...agent.inbox.nextTurn, ...agent.inbox.nextStep]).toEqual([])
      agent.followup(message('fresh'))
      await agent.whenIdle()
      expect(lastRequest(adapter)).not.toContain('queued')
    } finally {
      await ctx.fiber.dispose()
    }
  })
})
