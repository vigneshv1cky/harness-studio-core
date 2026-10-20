/**
 * Image offload executor for the compaction seam. When an image-capable route
 * fails a request with `IMAGE_OFFLOAD_REQUIRED`, the plugin records one
 * `image/offload` decision selecting the oldest retained input occurrences
 * and retries through the agent or compaction summary error waterfall. When
 * `toolImageMaxAgeSteps` is configured, it also records a decision before each
 * step omitting tool-result images that many model responses old. Every route
 * sends placeholder text for those occurrences in subsequent requests.
 *
 * @module @deepseek-ai/dsh-compaction-image-offload
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-compaction'
import type {} from '@deepseek-ai/dsh-session-projection'
import type { RequestErrorAction } from '@deepseek-ai/dsh-agent'
import { IMAGE_OFFLOAD_REQUIRED_CODE, LlmError } from '@deepseek-ai/dsh-llm'
import { offloadAgedToolImages, TOOL_IMAGE_AGE_KEY, toolImageAgeProjection } from './age-out.ts'
import { offloadOldestImages } from './image-offload.ts'
import { imageOffloadProjection } from './projection.ts'

export const name = 'compaction-image-offload'
export const inject = ['agents', 'sessions', 'sessionProjections']

/** Image offload configuration. */
export interface Config {
  /**
   * Omit a tool-result image from requests once this many later model responses
   * follow it. Omitted or `0`: tool-result images stay until a route rejects them.
   */
  toolImageMaxAgeSteps?: number
}

export const Config: z<Config> = z.object({
  toolImageMaxAgeSteps: z.number().step(1).min(0),
})

/**
 * Mount agent and summary recovery listeners and the optional age-out step hook.
 * @param ctx - the plugin context.
 * @param config - the validated plugin configuration.
 */
export function apply(ctx: Context, config: Config = {}): void {
  ctx.sessions.registerMessageProjection(imageOffloadProjection)
  const { toolImageMaxAgeSteps } = config
  if (toolImageMaxAgeSteps !== undefined && toolImageMaxAgeSteps > 0) {
    ctx.sessionProjections.register(toolImageAgeProjection)
    ctx.on('agent/pre-step', ({ agent, signal }, next) => {
      if (!signal.aborted) {
        // oxlint-disable-next-line typescript/no-non-null-assertion -- this plugin registered the key above
        const state = ctx.sessionProjections.stateOf(agent.session, TOOL_IMAGE_AGE_KEY)!
        offloadAgedToolImages(agent.session, state, toolImageMaxAgeSteps)
      }
      return next()
    })
  }
  ctx.on('agent/request-error', ({ agent, failure, signal }, next): Promise<RequestErrorAction> => {
    if (failure.code !== IMAGE_OFFLOAD_REQUIRED_CODE || failure.offloadImages === undefined || signal.aborted) return next()
    // A durable surface repair, not a provider retry: it spends no retry budget and logs no retry event.
    if (!offloadOldestImages(agent.session, agent.session.surface.nodes, failure.offloadImages)) return next()
    return Promise.resolve<RequestErrorAction>({ kind: 'retry' })
  })
  ctx.on('compaction/summary-error', ({ session, sourceEventSeqs, error, signal }, next) => {
    if (!(error instanceof LlmError)
      || error.code !== IMAGE_OFFLOAD_REQUIRED_CODE
      || error.failure.offloadImages === undefined) return next()
    signal?.throwIfAborted()
    if (!offloadOldestImages(session, sourceEventSeqs, error.failure.offloadImages)) return next()
    return true
  })
}
