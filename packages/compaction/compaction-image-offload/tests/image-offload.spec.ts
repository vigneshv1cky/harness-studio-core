/**
 * Image offload recovery: an adapter's `IMAGE_OFFLOAD_REQUIRED` failure
 * records exact image occurrences and retries without replacing messages.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import type { Agent } from '@deepseek-ai/dsh-agent'
import BasicCompactionEngine from '@deepseek-ai/dsh-compaction-basic'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import { ImageVariantId } from '@deepseek-ai/dsh-attachment'
import { resolveAdapterOptions } from '@deepseek-ai/dsh-llm-deepseek'
import { inlineImages } from '@deepseek-ai/dsh-llm-deepseek/src/images.ts'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { createAssistantMessage, createToolResultMessage, createUserMessage, projectOffloadedImages, offloadedImageText, IMAGE_OFFLOAD_REQUIRED_CODE, LlmAdapter, LlmError, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { isReplacementSurfaceEvent, SessionId } from '@deepseek-ai/dsh-session'
import type { Session, SessionSeq } from '@deepseek-ai/dsh-session'
import * as offload from '../src/index.ts'
import type {} from '../src/age-out.ts'

type ScriptEntry = StreamChunk[] | (() => never)

/** Replies one scripted stream per request and declares no retry policy. */
class ScriptedAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []
  serializeSummary = false

  constructor(readonly script: ScriptEntry[]) {
    super()
  }

  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    if (this.serializeSummary && options.purpose === 'compaction') {
      inlineImages(
        projectOffloadedImages(options.messages, ref => offloadedImageText(ref)),
        new Map([image('first').attachment].map(ref => [ref.attachmentId, {
          variantId: ImageVariantId(`sha256:${'b'.repeat(64)}`), attachment: ref,
          data: new Uint8Array(ref.bytes), mediaType: ref.mediaType, bytes: ref.bytes,
          width: ref.width, height: ref.height, depth: 'uchar', space: 'srgb', hasAlpha: false,
        }])),
        resolveAdapterOptions({ maxInlineRequestImageBytes: 1, inlineImageOffloadByteQuantum: 1 }),
      )
    }
    const entry = this.script.shift()
    if (entry === undefined) throw new Error('script exhausted')
    if (typeof entry === 'function') entry()
    else yield * entry
  }
}

function textResponse(text: string): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

function offloadRequired(offloadImages: number): () => never {
  return () => {
    throw new LlmError('request images exceed the route budget', IMAGE_OFFLOAD_REQUIRED_CODE, { offloadImages })
  }
}

async function harness(adapter: ScriptedAdapter, config: offload.Config = {}): Promise<Context> {
  const ctx = new Context()
  contexts.push(ctx)
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(offload, config)
  await ctx.plugin(AgentLoop, { agents: [] })
  ctx.llm.registerAdapter(['mock'], adapter)
  return ctx
}

const contexts: Context[] = []
afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
})

function image(name: string): Extract<ContentBlock, { type: 'image' }> {
  return {
    type: 'image',
    attachment: { attachmentId: `sha256:${'a'.repeat(64)}` as never, name, mediaType: 'image/png', bytes: 1, width: 1, height: 1 },
  }
}

function offloadedNames(options: GenerateOptions): string[] {
  const names: string[] = []
  for (const message of options.messages) {
    for (const block of message.content) {
      if (block.type === 'image' && block.offloaded === true) names.push(block.attachment.name ?? '')
    }
  }
  return names
}

/** Surface replacements appended by the recovery, as `[original seq, replacement seq]` pairs. */
function replacements(session: Session): [number, number][] {
  return session.snapshotEvents()
    .filter(isReplacementSurfaceEvent)
    .map(event => [Number(event.sourceEventSeqs?.[0]), Number(event.seq)])
}

function decisions(session: Session) {
  return session.snapshotEvents().filter(event => event.type === 'image/offload')
}

async function summaryHarness(script: ScriptEntry[]) {
  const adapter = new ScriptedAdapter(script)
  const ctx = await harness(adapter)
  await ctx.plugin(TokenMeter)
  const compact = new BasicCompactionEngine(ctx, { auto: false, summarizationProvider: 'mock', summarizationModel: 'summary' })
  const agent = await ctx.agentLoop.create(SessionId('summary-offload'), { provider: 'mock', model: 'mock' })
  return { ctx, compact, agent, adapter }
}

async function seedImages(agent: Agent, names: string[]) {
  agent.followup(createUserMessage({
    content: [{ type: 'text', text: 'conversation details '.repeat(400) }, ...names.map(image)],
    source: { kind: 'user' },
  }))
  await agent.whenIdle()
  const nodes = agent.session.surface.nodes
  return { start: nodes.at(-2)!, end: nodes.at(-1)! }
}

describe('summary image offload', () => {
  it.each([new Error('summary failed'), new LlmError('no count', IMAGE_OFFLOAD_REQUIRED_CODE)])('delegates unhandled summary errors: %s', async (error) => {
    const { ctx, agent } = await summaryHarness([])
    expect(ctx.waterfall('compaction/summary-error', { session: agent.session, sourceEventSeqs: [], error }, () => false)).toBe(false)
    expect(decisions(agent.session)).toEqual([])
  })

  it('recovers real summary image preparation with a tighter budget and fresh pricing', async () => {
    const { compact, agent, adapter } = await summaryHarness([textResponse('answer'), textResponse('checkpoint')])
    const span = await seedImages(agent, ['first', 'second'])
    adapter.serializeSummary = true
    const result = await compact.compactNow(agent, new AbortController().signal)
    expect(result).not.toBeNull()
    expect(adapter.requests.map(offloadedNames)).toEqual([[], [], ['first', 'second']])
    expect(adapter.requests.slice(1).map(request => request.model)).toEqual(['summary', 'summary'])
    const events = agent.session.snapshotEvents()
    const types = events.map(event => event.type)
    expect(types.filter(type => type === 'compaction/start')).toHaveLength(1)
    expect(types.filter(type => type === 'compaction/end')).toHaveLength(1)
    const [decision] = decisions(agent.session)
    expect(decision?.data.targets).toEqual([{ seq: span.start, imageIndexes: [0, 1] }])
    expect(decision!.seq).toBeLessThan(types.indexOf('compaction/summary'))
    expect(events[span.start]).not.toHaveProperty('data.content.1.offloaded')
    expect(types).not.toContain('compaction/prune')
    expect(types).not.toContain('llm/retry')
  })

  it('offloads only the selected summary span and stops after exhausting its images', async () => {
    const { compact, agent, adapter } = await summaryHarness([
      textResponse('before'), textResponse('selected'), textResponse('after'),
      offloadRequired(1), offloadRequired(1), offloadRequired(1),
    ])
    await seedImages(agent, ['outside-before'])
    const selected = await seedImages(agent, ['first', 'second'])
    await seedImages(agent, ['outside-after'])
    agent.session.append('turn/start', { turn: 4 })
    await expect(compact.compactRegion(selected.start, selected.end, agent)).rejects.toMatchObject({ code: IMAGE_OFFLOAD_REQUIRED_CODE })
    expect(adapter.requests.slice(3).map(offloadedNames)).toEqual([[], ['first'], ['first', 'second']])
    expect(decisions(agent.session).map(event => event.data.targets)).toEqual([
      [{ seq: selected.start, imageIndexes: [0] }], [{ seq: selected.start, imageIndexes: [1] }],
    ])
    expect(agent.session.surface.replaceGeneration).toBe(0)
    const end = agent.session.snapshotEvents().at(-1)
    expect(end?.type).toBe('compaction/end')
    expect(end?.type === 'compaction/end' && typeof end.data.error).toBe('string')
  })

  it('preserves omission when a subsequent summary failure is terminal', async () => {
    const { compact, agent, adapter } = await summaryHarness([
      textResponse('answer'), offloadRequired(1), () => { throw new LlmError('provider outage', 'SERVER') },
    ])
    await seedImages(agent, ['first'])
    await expect(compact.compactNow(agent, new AbortController().signal)).rejects.toMatchObject({ code: 'summary', cause: { code: 'SERVER' } })
    expect(adapter.requests).toHaveLength(3)
    expect(decisions(agent.session)).toHaveLength(1)
    expect(agent.session.surface.replaceGeneration).toBe(0)
  })

  it('does not record a decision after cancellation during a failed summary', async () => {
    const controller = new AbortController()
    const reason = new Error('cancel summary')
    const { compact, agent, adapter } = await summaryHarness([
      textResponse('answer'), () => { controller.abort(reason); return offloadRequired(1)() },
    ])
    await seedImages(agent, ['first'])
    await expect(compact.compactNow(agent, controller.signal)).rejects.toBe(reason)
    expect(adapter.requests).toHaveLength(2)
    expect(decisions(agent.session)).toEqual([])
  })

  it('does not retry when cancellation follows a durable omission', async () => {
    const { ctx, compact, agent, adapter } = await summaryHarness([textResponse('answer'), offloadRequired(1)])
    await seedImages(agent, ['first'])
    const controller = new AbortController()
    const reason = new Error('cancel after offload')
    ctx.on('session/event', (_session, event) => { if (event.type === 'image/offload') controller.abort(reason) })
    await expect(compact.compactNow(agent, controller.signal)).rejects.toBe(reason)
    expect(adapter.requests).toHaveLength(2)
    expect(decisions(agent.session)).toHaveLength(1)
  })

  it('rejects a concurrently changed selection before recording omission', async () => {
    const { compact, agent, adapter } = await summaryHarness([textResponse('answer')])
    const selected = await seedImages(agent, ['first'])
    adapter.script.push(() => {
      agent.session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'replacement' }], source: { kind: 'user' } }), {
        surfaceOp: { op: 'replace', startSeq: selected.start, endSeq: selected.end },
        sourceEventSeqs: [selected.start, selected.end],
      })
      return offloadRequired(1)()
    })
    await expect(compact.compactNow(agent, new AbortController().signal)).rejects.toMatchObject({ code: 'changed' })
    expect(decisions(agent.session)).toEqual([])
  })
})

describe('compaction-image-offload', () => {
  it('cancelling at failed-attempt settlement preserves images for later turns', async () => {
    const adapter = new ScriptedAdapter([offloadRequired(1), textResponse('continued')])
    const ctx = await harness(adapter)
    const agent = await ctx.agentLoop.create(SessionId('offload-cancel-before-record'), { provider: 'mock', model: 'mock' })
    ctx.on('session/event', (session, event) => {
      if (session === agent.session && event.type === 'assistant/attempt') agent.cancel({ kind: 'user' })
    })
    agent.followup(createUserMessage({ content: [image('original')], source: { kind: 'user' } }))
    await agent.whenIdle()
    expect(agent.session.snapshotEvents().find(event => event.type === 'turn/end'))
      .toMatchObject({ data: { reason: { kind: 'aborted' } } })
    expect(adapter.requests).toHaveLength(1)
    expect(decisions(agent.session)).toEqual([])

    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'continue' }], source: { kind: 'user' } }))
    await agent.whenIdle()
    expect(adapter.requests).toHaveLength(2)
    expect(offloadedNames(adapter.requests[1]!)).toEqual([])
    expect(agent.session.deriveMessages().flatMap(message => message.content)).toContainEqual(image('original'))
  })

  it('cancelling after an image omission stops retry and retains the committed selection', async () => {
    const adapter = new ScriptedAdapter([offloadRequired(1), textResponse('continued')])
    const ctx = await harness(adapter)
    const agent = await ctx.agentLoop.create(SessionId('offload-cancel-after-record'), { provider: 'mock', model: 'mock' })
    ctx.on('session/event', (session, event) => {
      if (session === agent.session && event.type === 'image/offload') agent.cancel({ kind: 'user' })
    })
    agent.followup(createUserMessage({ content: [image('original')], source: { kind: 'user' } }))
    await agent.whenIdle()
    expect(agent.session.snapshotEvents().find(event => event.type === 'turn/end'))
      .toMatchObject({ data: { reason: { kind: 'aborted' } } })
    expect(adapter.requests).toHaveLength(1)
    expect(decisions(agent.session)).toHaveLength(1)

    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'continue' }], source: { kind: 'user' } }))
    await agent.whenIdle()
    expect(adapter.requests).toHaveLength(2)
    expect(offloadedNames(adapter.requests[1]!)).toEqual(['original'])
    expect(decisions(agent.session)).toHaveLength(1)
  })

  it('logs one exact image selection and retries without replacing the message', async () => {
    const adapter = new ScriptedAdapter([offloadRequired(2), textResponse('sent')])
    const ctx = await harness(adapter)
    const agent = await ctx.agentLoop.create(SessionId('offload-required'), { provider: 'mock', model: 'mock' })
    const delegated: string[] = []
    ctx.on('agent/request-error', ({ failure }, next) => {
      delegated.push(failure.code)
      return next()
    })

    agent.followup(createUserMessage({
      content: [image('a'), image('b'), image('c')],
      source: { kind: 'user' },
    }))
    await agent.whenIdle()

    expect(adapter.requests).toHaveLength(2)
    expect(offloadedNames(adapter.requests[0]!)).toEqual([])
    expect(offloadedNames(adapter.requests[1]!)).toEqual(['a', 'b'])
    expect(delegated).toEqual([])
    const events = agent.session.snapshotEvents()
    const types = events.map(event => event.type)
    expect(types.filter(type => type === 'llm/retry')).toHaveLength(0)
    expect(types.filter(type => type === 'assistant/attempt')).toHaveLength(1)
    expect(replacements(agent.session)).toHaveLength(0)
    expect(types).not.toContain('compaction/prune')
    expect(decisions(agent.session)).toHaveLength(1)
    const decision = decisions(agent.session)[0]!
    const original = events.find(event => event.type === 'user/message')!.seq
    expect(decision.data).toEqual({ targets: [{ seq: original, imageIndexes: [0, 1] }] })
    expect(events[original]).toMatchObject({ type: 'user/message', surfaceOp: 'append' })
    expect(types.indexOf('assistant/attempt')).toBeLessThan(decision.seq)
    expect(decision.seq).toBeLessThan(types.indexOf('assistant/message'))
    expect(events[decision.seq + 1]).toMatchObject({ type: 'request/header', data: { reason: 'series' } })
    const durable = events[original]!
    expect(durable.type === 'user/message' ? durable.data.content[0] : undefined).not.toHaveProperty('offloaded')
  })

  it('counts the adapter prefix in request order after a surface replacement', async () => {
    const adapter = new ScriptedAdapter([offloadRequired(2), textResponse('sent')])
    const ctx = await harness(adapter)
    const agent = await ctx.agentLoop.create(SessionId('offload-reordered'), { provider: 'mock', model: 'mock' })
    // An empty-content assistant node derives no message and carries no occurrence.
    agent.session.append('assistant/message', {
      turn: 0,
      step: 0,
      message: createAssistantMessage({ content: [], source: { provider: 'mock', model: 'mock' } }),
      stream: [],
    }, { surfaceOp: 'append' })
    const first = agent.session.append('user/message', createUserMessage({
      content: [image('first')], source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    agent.session.append('user/message', createUserMessage({
      content: [image('second')], source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    agent.session.append('user/message', createUserMessage({
      content: [image('replacement')], source: { kind: 'user' },
    }), {
      surfaceOp: { op: 'replace', startSeq: first.seq, endSeq: first.seq },
      sourceEventSeqs: [first.seq],
    })

    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'send' }], source: { kind: 'user' } }))
    await agent.whenIdle()

    expect(adapter.requests).toHaveLength(2)
    expect(offloadedNames(adapter.requests[1]!)).toEqual(['replacement', 'second'])
    expect(replacements(agent.session)).toHaveLength(1)
    expect(decisions(agent.session).map(event => event.data.targets)).toEqual([[
      { seq: 3, imageIndexes: [0] }, { seq: 2, imageIndexes: [0] },
    ]])
  })

  it('offloads a tool-result image and leaves later images untouched', async () => {
    const adapter = new ScriptedAdapter([offloadRequired(1), textResponse('sent')])
    const ctx = await harness(adapter)
    const agent = await ctx.agentLoop.create(SessionId('offload-tool-result'), { provider: 'mock', model: 'mock' })
    const emptyCallId = ToolCallId('empty')
    const callId = ToolCallId('shot')
    const innerCallId = ToolCallId('inner')
    agent.session.append('turn/start', { turn: 0 })
    agent.session.append('assistant/message', {
      turn: 0,
      step: 1,
      message: createAssistantMessage({
        content: [
          { type: 'tool-call', id: emptyCallId, name: 'read_image', arguments: '{}' },
          { type: 'tool-call', id: callId, name: 'read_image', arguments: '{}' },
          { type: 'tool-call', id: innerCallId, name: 'read_image', arguments: '{}' },
        ],
        source: { provider: 'mock', model: 'mock' },
      }),
      stream: [],
    }, { surfaceOp: 'append' })
    agent.session.append('tool/call', { turn: 0, step: 1, callId: emptyCallId, name: 'read_image', arguments: '{}' })
    agent.session.append('tool/result', {
      turn: 0,
      step: 1,
      message: createToolResultMessage({
        callId: emptyCallId,
        content: [{ type: 'text', text: 'no image' }],
        isError: false,
      }),
    }, { surfaceOp: 'append' })
    agent.session.append('tool/call', { turn: 0, step: 1, callId, name: 'read_image', arguments: '{}' })
    const result = agent.session.append('tool/result', {
      turn: 0,
      step: 1,
      message: createToolResultMessage({
        callId,
        content: [image('first')],
        isError: false,
      }),
    }, { surfaceOp: 'append' })
    agent.session.append('tool/call', { turn: 0, step: 1, callId: innerCallId, name: 'read_image', arguments: '{}' })
    agent.session.append('tool/result', {
      turn: 0,
      step: 1,
      message: createToolResultMessage({
        callId: innerCallId,
        content: [image('second')],
        isError: false,
      }),
    }, { surfaceOp: 'append' })
    agent.session.append('turn/end', { turn: 0, reason: { kind: 'completed' } })

    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'send' }], source: { kind: 'user' } }))
    await agent.whenIdle()

    expect(offloadedNames(adapter.requests[1]!)).toEqual(['first'])
    expect(replacements(agent.session)).toHaveLength(0)
    expect(decisions(agent.session)[0]?.data).toEqual({ targets: [{ seq: result.seq, imageIndexes: [0] }] })
    expect(agent.session.deriveEventMessage(result)?.source).toEqual(result.data.message.source)
  })

  it('advances across consecutive failures and preserves the first request snapshot', async () => {
    const adapter = new ScriptedAdapter([offloadRequired(1), offloadRequired(1), textResponse('sent')])
    const ctx = await harness(adapter)
    const agent = await ctx.agentLoop.create(SessionId('offload-repeat'), { provider: 'mock', model: 'mock' })
    agent.followup(createUserMessage({
      content: [image('first'), image('second'), image('third')], source: { kind: 'user' },
    }))
    await agent.whenIdle()
    expect(adapter.requests.map(offloadedNames)).toEqual([[], ['first'], ['first', 'second']])
    expect(decisions(agent.session).map(event => event.data.targets[0]?.imageIndexes)).toEqual([[0], [1]])
    expect(agent.session.surface.replaceGeneration).toBe(0)
    expect(agent.session.surface.contentGeneration).toBe(2)
  })

  it('removes the recovery listener when its plugin is disposed', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    await mountAgentLoopTestDependencies(ctx)
    const fiber = ctx.plugin(offload)
    await fiber
    await fiber.dispose()
    const adapter = new ScriptedAdapter([offloadRequired(1)])
    ctx.llm.registerAdapter(['mock'], adapter)
    await ctx.plugin(AgentLoop, { agents: [] })
    const agent = await ctx.agentLoop.create(SessionId('offload-unloaded'), { provider: 'mock', model: 'mock' })
    agent.followup(createUserMessage({ content: [image('a')], source: { kind: 'user' } }))
    await agent.whenIdle()
    expect(adapter.requests).toHaveLength(1)
    expect(decisions(agent.session)).toEqual([])
    expect(ctx.waterfall('compaction/summary-error', {
      session: agent.session,
      sourceEventSeqs: agent.session.surface.nodes,
      error: new LlmError('summary budget exceeded', IMAGE_OFFLOAD_REQUIRED_CODE, { offloadImages: 1 }),
    }, () => false)).toBe(false)
    expect(decisions(agent.session)).toEqual([])
  })

  it('leaves every other failure to downstream recovery', async () => {
    const adapter = new ScriptedAdapter([() => {
      throw new LlmError('provider outage', 'SERVER')
    }])
    const ctx = await harness(adapter)
    const agent = await ctx.agentLoop.create(SessionId('offload-other-failure'), { provider: 'mock', model: 'mock' })
    const delegated: string[] = []
    ctx.on('agent/request-error', ({ failure }, next) => {
      delegated.push(failure.code)
      return next()
    })
    agent.followup(createUserMessage({ content: [image('a')], source: { kind: 'user' } }))
    await agent.whenIdle()
    expect(delegated).toEqual(['SERVER'])
    expect(replacements(agent.session)).toHaveLength(0)
  })

  it('delegates IMAGE_OFFLOAD_REQUIRED once nothing remains to offload', async () => {
    const adapter = new ScriptedAdapter([offloadRequired(1)])
    const ctx = await harness(adapter)
    const agent = await ctx.agentLoop.create(SessionId('offload-exhausted'), { provider: 'mock', model: 'mock' })
    const delegated: string[] = []
    ctx.on('agent/request-error', ({ failure }, next) => {
      delegated.push(failure.code)
      return next()
    })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'no images' }], source: { kind: 'user' } }))
    await agent.whenIdle()
    expect(delegated).toEqual([IMAGE_OFFLOAD_REQUIRED_CODE])
    expect(replacements(agent.session)).toHaveLength(0)
    expect(agent.session.snapshotEvents().at(-1)).toMatchObject({ type: 'turn/end', data: { reason: { kind: 'error' } } })
  })
})

/** Append one completed step whose tool calls return the given contents. */
function appendToolStep(session: Session, step: number, results: ContentBlock[][]): SessionSeq[] {
  const ids = results.map((_, index) => ToolCallId(`call-${step}-${index}`))
  session.append('assistant/message', {
    turn: 0,
    step,
    message: createAssistantMessage({
      content: ids.map(id => ({ type: 'tool-call' as const, id, name: 'read_image', arguments: '{}' })),
      source: { provider: 'mock', model: 'mock' },
    }),
    stream: [],
  }, { surfaceOp: 'append' })
  return results.map((content, index) => {
    session.append('tool/call', { turn: 0, step, callId: ids[index]!, name: 'read_image', arguments: '{}' })
    return session.append('tool/result', {
      turn: 0,
      step,
      message: createToolResultMessage({ callId: ids[index]!, content, isError: false }),
    }, { surfaceOp: 'append' }).seq
  })
}

describe('tool-image age-out', () => {
  async function agedHarness(script: ScriptEntry[], config: offload.Config = { toolImageMaxAgeSteps: 2 }) {
    const adapter = new ScriptedAdapter(script)
    const ctx = await harness(adapter, config)
    const agent = await ctx.agentLoop.create(SessionId('offload-aged'), { provider: 'mock', model: 'mock' })
    agent.session.append('turn/start', { turn: 0 })
    const attached = agent.session.append('user/message', createUserMessage({ content: [image('attached')], source: { kind: 'user' } }), { surfaceOp: 'append' }).seq
    const [oldest, imageless] = appendToolStep(agent.session, 1, [[image('oldest'), image('oldest-second')], [{ type: 'text', text: 'no image' }]])
    const [older] = appendToolStep(agent.session, 2, [[{ type: 'text', text: 'frame' }, image('older')]])
    const [recent] = appendToolStep(agent.session, 3, [[image('recent')]])
    agent.session.append('turn/end', { turn: 0, reason: { kind: 'completed' } })
    return { ctx, agent, adapter, seqs: { attached, oldest: oldest!, imageless: imageless!, older: older!, recent: recent! } }
  }

  it('omits tool-result images once enough model responses follow them and keeps user images', async () => {
    const { agent, adapter, seqs } = await agedHarness(['first', 'second', 'third', 'fourth'].map(textResponse))
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'continue' }], source: { kind: 'user' } }))
    await agent.whenIdle()
    expect(offloadedNames(adapter.requests[0]!)).toEqual(['oldest', 'oldest-second'])
    expect(decisions(agent.session).map(event => event.data.targets)).toEqual([
      [{ seq: seqs.oldest, imageIndexes: [0, 1] }],
    ])

    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'again' }], source: { kind: 'user' } }))
    await agent.whenIdle()
    expect(offloadedNames(adapter.requests[1]!)).toEqual(['oldest', 'oldest-second', 'older'])
    expect(decisions(agent.session).map(event => event.data.targets)).toEqual([
      [{ seq: seqs.oldest, imageIndexes: [0, 1] }],
      [{ seq: seqs.older, imageIndexes: [0] }],
    ])

    for (const text of ['third', 'fourth']) {
      agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
      await agent.whenIdle()
    }
    expect(adapter.requests.slice(2).map(offloadedNames)).toEqual([
      ['oldest', 'oldest-second', 'older', 'recent'], ['oldest', 'oldest-second', 'older', 'recent'],
    ])
    expect(decisions(agent.session).at(-1)?.data.targets).toEqual([{ seq: seqs.recent, imageIndexes: [0] }])
    expect(decisions(agent.session)).toHaveLength(3)
    const types = agent.session.snapshotEvents().map(event => event.type)
    expect(types).not.toContain('compaction/prune')
    expect(replacements(agent.session)).toHaveLength(0)
    expect(agent.session.deriveMessages().flatMap(message => message.content)).toContainEqual(image('attached'))
  })

  it('selects only images not already omitted within a message', async () => {
    const { agent, adapter, seqs } = await agedHarness([textResponse('done')], { toolImageMaxAgeSteps: 1 })
    agent.session.append('image/offload', { targets: [{ seq: seqs.attached, imageIndexes: [0] }] })
    agent.session.append('image/offload', { targets: [{ seq: seqs.oldest, imageIndexes: [0] }] })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'continue' }], source: { kind: 'user' } }))
    await agent.whenIdle()
    expect(offloadedNames(adapter.requests[0]!)).toEqual(['attached', 'oldest', 'oldest-second', 'older'])
    expect(decisions(agent.session).at(-1)?.data.targets).toEqual([
      { seq: seqs.oldest, imageIndexes: [1] }, { seq: seqs.older, imageIndexes: [0] },
    ])
  })

  it('follows a replaced tool result and forgets one condensed away', async () => {
    const { agent, adapter, seqs } = await agedHarness(['first', 'second', 'third'].map(textResponse))
    const recent = agent.session.eventAt(seqs.recent)
    if (recent?.type !== 'tool/result') throw new Error('expected the recent tool result')
    const message = { ...recent.data.message, content: [{ ...image('stale'), offloaded: true as const }, ...recent.data.message.content] }
    const replacement = agent.session.append('tool/result', { ...recent.data, message }, {
      surfaceOp: { op: 'replace', startSeq: seqs.recent, endSeq: seqs.recent },
      sourceEventSeqs: [seqs.recent],
    }).seq
    agent.session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'summary' }], source: { kind: 'user' } }), {
      surfaceOp: { op: 'replace', startSeq: seqs.older, endSeq: seqs.older },
      sourceEventSeqs: [seqs.older],
    })
    agent.session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'no images here' }], source: { kind: 'user' } }), {
      surfaceOp: { op: 'replace', startSeq: seqs.imageless, endSeq: seqs.imageless },
      sourceEventSeqs: [seqs.imageless],
    })
    for (const text of ['continue', 'again', 'once more']) {
      agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
      await agent.whenIdle()
    }
    expect(adapter.requests.map(offloadedNames)).toEqual([
      ['oldest', 'oldest-second', 'stale'], ['oldest', 'oldest-second', 'stale'], ['oldest', 'oldest-second', 'stale', 'recent'],
    ])
    expect(decisions(agent.session).map(event => event.data.targets)).toEqual([
      [{ seq: seqs.oldest, imageIndexes: [0, 1] }],
      [{ seq: replacement, imageIndexes: [1] }],
    ])
  })

  it.each([{}, { toolImageMaxAgeSteps: 0 }])('records nothing without a positive setting: %j', async (config) => {
    const { agent, adapter } = await agedHarness([textResponse('done')], config)
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'continue' }], source: { kind: 'user' } }))
    await agent.whenIdle()
    expect(offloadedNames(adapter.requests[0]!)).toEqual([])
    expect(decisions(agent.session)).toEqual([])
  })

  it('records nothing for a cancelled step', async () => {
    const { ctx, agent } = await agedHarness([])
    const controller = new AbortController()
    controller.abort()
    await ctx.waterfall('agent/pre-step', { agent, messages: [], turn: 1, step: 1, signal: controller.signal }, () => Promise.resolve({ kind: 'enter' as const, messages: [] }))
    expect(decisions(agent.session)).toEqual([])
  })

  it('rejects a negative or fractional age', () => {
    expect(() => offload.Config({ toolImageMaxAgeSteps: -1 })).toThrow()
    expect(() => offload.Config({ toolImageMaxAgeSteps: 1.5 })).toThrow()
    expect(offload.Config({ toolImageMaxAgeSteps: 5 })).toEqual({ toolImageMaxAgeSteps: 5 })
  })

  it('removes the step hook when its plugin is disposed', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    await mountAgentLoopTestDependencies(ctx)
    const fiber = ctx.plugin(offload, { toolImageMaxAgeSteps: 1 })
    await fiber
    await fiber.dispose()
    const adapter = new ScriptedAdapter([textResponse('done')])
    ctx.llm.registerAdapter(['mock'], adapter)
    await ctx.plugin(AgentLoop, { agents: [] })
    const agent = await ctx.agentLoop.create(SessionId('offload-aged-unloaded'), { provider: 'mock', model: 'mock' })
    appendToolStep(agent.session, 1, [[image('kept')]])
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'continue' }], source: { kind: 'user' } }))
    await agent.whenIdle()
    expect(offloadedNames(adapter.requests[0]!)).toEqual([])
    expect(decisions(agent.session)).toEqual([])
    expect(ctx.sessionProjections.stateOf(agent.session, 'toolImageAge')).toBeUndefined()
  })
})
