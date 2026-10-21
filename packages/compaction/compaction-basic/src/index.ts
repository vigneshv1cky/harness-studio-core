/**
 * Basic replay-aware compaction backend.
 *
 * @module @deepseek-ai/dsh-compaction-basic
 */

import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { CompactionEngine, ManualCompactionError } from '@deepseek-ai/dsh-compaction'
import type { CompactionResult, CompactionTrigger } from '@deepseek-ai/dsh-compaction'
import type { Session, SessionSeq } from '@deepseek-ai/dsh-session'
import { CONTEXT_WINDOW_EXCEEDED_CODE } from '@deepseek-ai/dsh-llm'
import type { LlmCallConfig } from '@deepseek-ai/dsh-llm'
import { assertNever } from '@deepseek-ai/dsh-util-values'
import { agentEvents } from '@deepseek-ai/dsh-agent'
import type { Agent, PreStepDecision, RequestErrorAction } from '@deepseek-ai/dsh-agent'
import type { EpochHeader } from '@deepseek-ai/dsh-session'
import type { CommandId } from '@deepseek-ai/dsh-commands/brand'
// Type-only: makes the optional sibling service available to `ctx.get()`.
import type {} from '@deepseek-ai/dsh-compaction-tool-result-pruner'
import {
  resolveCompactSpec,
  resolveConfig,
  resolveTargetPolicy,
  TargetPressureConfigError,
} from './config.ts'
import {
  assertNoActiveCompaction,
  compactSurfaceRegion,
  selectCompactableRange,
} from './region.ts'
import { summarizeWithLlm } from './summarizer.ts'
import type { SummarizationInput, SummaryResult } from './summarizer.ts'
import type {
  BasicCompactionConfig,
  ModelCompactPolicyConfig,
  ResolvedConfig,
} from './types.ts'

export type {
  BasicCompactionConfig,
  CompactionPolicyConfig,
  ModelCompactPolicyConfig,
  ResolvedCompactSpec,
  ResolvedConfig,
  ResolvedRetention,
  ResolvedTargetPolicy,
} from './types.ts'

type Target = Pick<LlmCallConfig, 'provider' | 'model'>

/** Resolve the exact provider/model durably routed for the latest request. */
function routedTarget(session: Session): Target | undefined {
  const config = session.requestHeader()?.config
  if (config === undefined || config.provider.length === 0 || config.model.length === 0) {
    return undefined
  }
  return { provider: config.provider, model: config.model }
}

function sameTarget(left: Target, right: Target | undefined): boolean {
  return left.provider === right?.provider && left.model === right.model
}

/**
 * Output tokens the routed request reserves, which the provider charges to the
 * same window as the prompt. The effective envelope's own cap wins while it
 * routes `target`; after a switch, the agent's configured cap or the adapter's
 * per-request default for the new model. No declared cap means no reservation.
 */
function reservedCompletionTokens(agent: Agent, target: Target, defaultMaxTokens: number | undefined): number {
  const config = agent.session.requestHeader()?.config
  const configured = config !== undefined && sameTarget(target, config) ? config.maxTokens : agent.options.maxTokens
  return configured ?? defaultMaxTokens ?? 0
}

/**
 * The latest request envelope re-addressed to `target`, so the token meter
 * prices the surface for the model that sends next and does not reuse the
 * usage another model reported for that envelope.
 */
function headerFor(session: Session, target: Target): EpochHeader | undefined {
  const header = session.requestHeader()
  if (header === undefined || sameTarget(target, header.config)) return undefined
  return { ...header, config: { provider: target.provider, model: target.model } }
}

/** Overflow recovery progress for one agent's current request sequence. */
interface OverflowState {
  /** Overflow retries already authorized. */
  readonly retries: number
  /** Estimated size of the first request the provider refused. */
  readonly refusedTokens: number
}

/** What one running compaction measures against, read by {@link BasicCompactionEngine.summarize}. */
interface CompactionPlan {
  /** Conversation route the compaction measures; resolved when the summary starts when absent. */
  readonly target?: Target
  /** Resolve an absent target from the pending selection of an idle agent. */
  readonly pending?: boolean
  /** Largest summary request size an overflow retry allows. */
  readonly overflowBudget?: number
}

const thresholdRatioSchema = z.number()
const headroomTokensSchema = z.number().step(1).min(0)
const retainRatioSchema = z.number()
const retainTokensSchema = z.number().step(1).min(0)
const summarizationProviderSchema = z.string()
const summarizationModelSchema = z.string()
const maxTokensSchema = z.number().step(1).min(1)
const compactionRetriesSchema = z.number().step(1).min(0)
const maxOverflowRetriesSchema = z.number().step(1).min(0)
const overflowShrinkRatiosSchema = z.array(z.number())

const modelPolicy: z<ModelCompactPolicyConfig> = z.object({
  provider: z.string().required(),
  model: z.string().required(),
  thresholdRatio: thresholdRatioSchema,
  headroomTokens: headroomTokensSchema,
  retainRatio: retainRatioSchema,
  retainTokens: retainTokensSchema,
  summarizationProvider: summarizationProviderSchema,
  summarizationModel: summarizationModelSchema,
  maxTokens: maxTokensSchema,
  compactionRetries: compactionRetriesSchema,
  maxOverflowRetries: maxOverflowRetriesSchema,
  overflowShrinkRatios: overflowShrinkRatiosSchema,
})

/**
 * Dependency-light compaction backend using `ctx.tokenMeter` for pressure,
 * retention, cited source events, and summary-convergence pricing.
 *
 * `summarize()` is the sole subclass customization hook; the replay and durable
 * mutation strategy stays fixed so every pricing decision uses the singleton
 * token meter.
 */
export class BasicCompactionEngine extends CompactionEngine {
  static inject = ['llm', 'tokenMeter', 'sessions']

  static Config: z<BasicCompactionConfig> = z.object({
    thresholdRatio: thresholdRatioSchema,
    headroomTokens: headroomTokensSchema,
    retainRatio: retainRatioSchema,
    retainTokens: retainTokensSchema,
    summarizationProvider: summarizationProviderSchema,
    summarizationModel: summarizationModelSchema,
    maxTokens: maxTokensSchema,
    compactionRetries: compactionRetriesSchema,
    maxOverflowRetries: maxOverflowRetriesSchema,
    overflowShrinkRatios: overflowShrinkRatiosSchema,
    modelPolicies: z.array(modelPolicy),
    auto: z.boolean(),
  })

  /** Resolved and validated compaction configuration. */
  readonly config: ResolvedConfig

  private readonly warnedPressureConfigTargets = new Set<string>()
  private readonly overflowStates = new WeakMap<Agent, OverflowState>()
  private readonly overflowAgents = new WeakMap<Session, Agent>()
  private readonly plans = new WeakMap<Agent, CompactionPlan>()

  constructor(ctx: Context, config: BasicCompactionConfig = {}) {
    super(ctx)
    this.config = resolveConfig(config)
    if (this.config.auto) this._registerAutomaticCompaction()
  }

  /**
   * Register automatic between-step pressure and model-request overflow
   * recovery. `compactIfNeeded` stays dynamically dispatched so subclass
   * overrides are honored at event time.
   */
  private _registerAutomaticCompaction(): void {
    const { ctx } = this
    const logResult = (result: CompactionResult, trigger: string): void => {
      ctx.logger.info(
        `compaction (${trigger}): shadowed ${result.shadowedSeqs.length} surface nodes `
        + `(seqs ${result.shadowedRange.start}-${result.shadowedRange.end}, `
        + `~${result.shadowedTokenCount} tokens)`,
      )
    }

    ctx.on('agent/pre-step', async (
      { agent, signal },
      next,
    ): Promise<PreStepDecision> => {
      if (!signal.aborted) {
        try {
          const result = await this.compactIfNeeded(agent, 'pressure', signal)
          if (result !== null) logResult(result, 'step pressure')
        } catch (error: unknown) {
          if (error instanceof TargetPressureConfigError) {
            if (this.warnedPressureConfigTargets.has(error.targetKey)) return next()
            this.warnedPressureConfigTargets.add(error.targetKey)
          }
          const message = error instanceof Error ? error.message : String(error)
          ctx.logger.warn(`step compaction failed: ${message}; continuing the turn`)
        }
      }
      return next()
    })

    ctx.on('agent/status', ({ agent, status }) => {
      if (status === 'idle') this.overflowStates.delete(agent)
    })

    // A successful response starts a fresh overflow-recovery sequence even
    // when tool calls continue the same turn into another request.
    ctx.on('session/event', (session, event) => {
      if (event.type !== 'assistant/message') return
      const agent = this.overflowAgents.get(session)
      if (agent !== undefined) this.overflowStates.delete(agent)
    })

    ctx.on('agent/request-error', async (
      { agent, failure, signal },
      next,
    ) => {
      if (failure.code !== CONTEXT_WINDOW_EXCEEDED_CODE || signal.aborted) return next()
      this.overflowAgents.set(agent.session, agent)
      const target = routedTarget(agent.session)
      if (target === undefined) return next()
      const policy = resolveTargetPolicy(this.config, target)
      const state = this.overflowStates.get(agent)
      const retries = state?.retries ?? 0
      if (retries >= policy.maxOverflowRetries) return next()
      // The provider refused a request the estimate let through, so each retry
      // aims below the first refused size by the next shrink ratio.
      const refusedTokens = state?.refusedTokens ?? this.ctx.tokenMeter.measure(agent.session).totalTokens
      // oxlint-disable-next-line typescript/no-non-null-assertion -- config validation keeps maxOverflowRetries <= the ratio count
      const overflowBudget = Math.floor(refusedTokens * policy.overflowShrinkRatios[retries]!)
      const authorize = (): RequestErrorAction => {
        this.overflowStates.set(agent, { retries: retries + 1, refusedTokens })
        return { kind: 'retry' }
      }

      const generation = agent.session.surface.replaceGeneration
      let result: CompactionResult | null
      try {
        result = await this.runPlanned(agent, { target, overflowBudget }, () => (
          this.compactIfNeeded(agent, 'context-overflow', signal)
        ))
      } catch (recoveryError: unknown) {
        const message = recoveryError instanceof Error ? recoveryError.message : String(recoveryError)
        // A model-free prune can land before later summary work fails. That
        // durable reduction is sufficient retry proof; do not discard it just
        // because the optional second phase threw. Cancellation still wins.
        // oxlint-disable-next-line typescript/no-unnecessary-condition -- the signal can abort while recovery is awaited.
        if (!signal.aborted && agent.session.surface.replaceGeneration > generation) {
          ctx.logger.warn(
            `context-overflow compaction failed after durable surface progress: ${message}; `
            + 'retrying from the replacement surface',
          )
          return authorize()
        }
        ctx.logger.warn(
          // oxlint-disable-next-line typescript/no-unnecessary-condition -- the signal can abort while recovery is awaited.
          `context-overflow compaction failed: ${message}; ${signal.aborted
            ? 'cancellation prevents retry'
            : 'preserving the original request error'}`,
        )
        return next()
      }
      // oxlint-disable-next-line typescript/no-unnecessary-condition -- the signal can abort while compaction is awaited.
      if (signal.aborted
        || agent.session.surface.replaceGeneration <= generation) return next()
      if (result !== null) logResult(result, 'context overflow recovery')
      return authorize()
    })
  }

  /**
   * Resolve the provider/model the agent's next request uses: a model
   * selection's route when one is installed, otherwise the latest routed
   * request, otherwise the `AgentOptions` pair.
   * @param agent - agent whose route is resolved.
   * @param pending - true for an idle agent, whose next prompt assembly takes the pending selection.
   * @returns the route, or `undefined` when none is known.
   */
  private async nextTarget(agent: Agent, pending: boolean): Promise<Target | undefined> {
    const selected = await agentEvents(this.ctx, agent).waterfall(
      'agent/model-selection', { pending },
      () => Promise.resolve<Target | undefined>(undefined),
    )
    if (selected !== undefined) return selected
    const routed = routedTarget(agent.session)
    if (routed !== undefined) return routed
    if (agent.options.provider === undefined || agent.options.provider.length === 0
      || agent.options.model === undefined || agent.options.model.length === 0) return undefined
    return { provider: agent.options.provider, model: agent.options.model }
  }

  /** Run one compaction with its plan visible to {@link summarize}. */
  private async runPlanned<T>(agent: Agent, plan: CompactionPlan, run: () => Promise<T>): Promise<T> {
    const previous = this.plans.get(agent)
    this.plans.set(agent, plan)
    try {
      return await run()
    } finally {
      if (previous === undefined) this.plans.delete(agent)
      else this.plans.set(agent, previous)
    }
  }

  /**
   * Largest summary request the summarizing model takes while leaving room for
   * the summary itself: its window minus the summary cap, lowered to an
   * overflow retry's budget. `undefined` when neither is known.
   */
  private async summaryBudget(
    target: Target | undefined,
    maxTokens: number,
    overflowBudget: number | undefined,
    signal?: AbortSignal,
  ): Promise<number | undefined> {
    let ceiling: number | undefined
    if (target !== undefined) {
      try {
        const window = (await this.ctx.llm.resolveModelInfo(target.provider, target.model, signal)).context?.contextWindow
        if (window !== undefined && window > maxTokens) ceiling = window - maxTokens
      } catch (error: unknown) {
        // A route without model metadata limits the summary request only by an overflow budget.
        signal?.throwIfAborted()
        this.ctx.logger.debug(`compaction: no model metadata for ${target.provider}/${target.model}: ${String(error)}`)
      }
    }
    if (ceiling === undefined) return overflowBudget
    return overflowBudget === undefined ? ceiling : Math.min(ceiling, overflowBudget)
  }

  /**
   * Summarize the replayed conversation region through a direct one-shot
   * `ctx.llm.stream()` call whose prefix reuses the conversation's own system
   * prompt, tools, and messages so the provider's KV cache is not invalidated.
   * Override this sole hook for a template or remote summarizer.
   * @param input - replayed conversation prefix (system, tools, and leading messages) to condense.
   * @param agent - supplies routed-model history, fallback model, and session id.
   * @param signal - optional cancellation forwarded to the adapter.
   * @returns safe text summary blocks and the exact auxiliary call envelope and output.
   */
  protected async summarize(
    input: SummarizationInput,
    agent: Agent,
    signal?: AbortSignal,
  ): Promise<SummaryResult> {
    const plan = this.plans.get(agent)
    const target = plan?.target ?? await this.nextTarget(agent, plan?.pending ?? false)
    const config = target === undefined
      ? this.config
      : resolveTargetPolicy(this.config, target)
    const summaryTarget = config.summarizationProvider.length === 0
      ? target
      : { provider: config.summarizationProvider, model: config.summarizationModel }
    const budget = await this.summaryBudget(summaryTarget, config.maxTokens, plan?.overflowBudget, signal)
    return summarizeWithLlm(this.ctx, {
      ...config,
      ...summaryTarget === undefined ? {} : { target: summaryTarget },
      ...budget === undefined ? {} : { budget },
    }, input, agent, signal)
  }

  /**
   * Compact for replayed step-boundary pressure or one provider-confirmed context
   * overflow. Both triggers price the latest durable routed request envelope;
   * overflow bypasses the normal threshold and retained-tail policy so it can
   * force one useful balanced reduction.
   * @param agent - agent whose latest durable routed request is measured.
   * @param trigger - normal step-boundary pressure or context-overflow recovery.
   * @param signal - live turn cancellation signal forwarded to summarization.
   * @returns the latest summary compaction result, or `null` when no summary ran.
   */
  override async compactIfNeeded(
    agent: Agent,
    trigger: CompactionTrigger,
    signal: AbortSignal,
  ): Promise<CompactionResult | null> {
    if (routedTarget(agent.session) === undefined) return null
    let target: Target
    switch (trigger) {
      case 'context-overflow':
        // The refused request's own route, durably logged before it was sent.
        // oxlint-disable-next-line typescript/no-non-null-assertion -- checked above
        target = routedTarget(agent.session)!
        break
      case 'pressure':
        // oxlint-disable-next-line typescript/no-non-null-assertion -- a routed session always resolves a target
        target = (await this.nextTarget(agent, false))!
        signal.throwIfAborted()
        break
      /* v8 ignore next -- closed-union exhaustiveness guard */
      default:
        assertNever(trigger, 'compaction trigger')
    }
    const policy = resolveTargetPolicy(this.config, target)
    const meter = this.ctx.tokenMeter
    // After a switch, price the surface for the next model and ignore the usage the previous one reported.
    const header = headerFor(agent.session, target)
    const measure = () => meter.measure(agent.session, header)
    let measurement = measure()
    const plan: CompactionPlan = { target, ...this.plans.get(agent) }

    // Pruning is optional so compaction-basic remains independently composable.
    // Overflow always qualifies; pressure first resolves the routed model's
    // capacity and checks its target-specific threshold.
    const prune = this.ctx.get('toolResultPruner')

    if (trigger === 'context-overflow') {
      if (prune !== undefined) {
        prune.pruneSession(agent.session)
        measurement = measure()
      }
      const range = selectCompactableRange(agent.session, measurement, 0)
      if (range === null) return null
      return this.runPlanned(agent, plan, () => this.compactRegion(range.start, range.end, agent, signal))
    }

    const info = await this.ctx.llm.resolveModelInfo(target.provider, target.model, signal)
    assertNoActiveCompaction(agent.session, 'automatic pressure compaction')
    const targetKey = `${target.provider}/${target.model}`
    if (info.context === undefined) {
      throw new TargetPressureConfigError(
        targetKey,
        `compaction-basic: no context capacity for ${targetKey}; `
        + 'configure contextWindow on that adapter model',
      )
    }
    const spec = resolveCompactSpec(
      policy,
      info.context.contextWindow,
      reservedCompletionTokens(agent, target, info.defaultMaxTokens),
    )
    if (measurement.totalTokens < spec.thresholdTokens) return null

    // Once pressure qualifies, land the model-free pass before choosing a
    // summary range, then remeasure through the singleton replay fold.
    if (prune !== undefined) {
      prune.pruneSession(agent.session)
      measurement = measure()
    }
    if (measurement.totalTokens < spec.thresholdTokens) return null

    let result: CompactionResult | null = null
    for (let attempt = 0; attempt <= spec.compactionRetries; attempt += 1) {
      const range = selectCompactableRange(agent.session, measurement, spec.retainTokens)
      if (range === null) {
        /* v8 ignore else -- concrete replacement preserves a compactable checkpoint; subclass hooks cannot mutate it. */
        if (result === null) return null
        /* v8 ignore next -- paired with the defensive post-success branch above. */
        break
      }
      result = await this.runPlanned(agent, plan, () => this.compactRegion(range.start, range.end, agent, signal))
      measurement = measure()
      if (measurement.totalTokens < spec.thresholdTokens) return result
    }

    throw new Error(
      `compaction still above threshold after ${spec.compactionRetries + 1} compaction attempts `
      + `(${measurement.totalTokens} estimated tokens >= threshold ${spec.thresholdTokens})`,
    )
  }

  /**
   * Compact one inclusive positional range from the agent-owned surface using
   * the effective token meter for all retention and shrink pricing.
   * @param start - inclusive first surface-node seq.
   * @param end - inclusive last surface-node seq.
   * @param agent - owner of the target session, used by the summarizer.
   * @param signal - optional summarization cancellation signal.
   * @returns the successful durable compaction result.
   */
  override async compactRegion(
    start: SessionSeq,
    end: SessionSeq,
    agent: Agent,
    signal?: AbortSignal,
  ): Promise<CompactionResult> {
    return compactSurfaceRegion(
      this.regionDependencies(),
      agent.session,
      start,
      end,
      agent,
      { owner: 'current-turn', stability: 'whole-surface' },
      signal,
    )
  }

  /**
   * Force one useful idle-session compaction below the pressure threshold, and
   * resolve only after its standalone marker pair is durably checkpointed.
   * @param agent - idle agent whose next-turn admission this call reserves.
   * @param signal - cancellation scoped to this compaction request.
   * @param sourceCommandId - initiating command identity for presentation correlation.
   * @returns the committed result, or `null` when no safe useful range exists.
   */
  override compactNow(
    agent: Agent,
    signal: AbortSignal,
    sourceCommandId?: CommandId,
  ): Promise<CompactionResult | null> {
    signal.throwIfAborted()
    try {
      return agent.runMaintenance(async (agentSignal) => {
        const operationSignal = AbortSignal.any([agentSignal, signal])
        try {
          operationSignal.throwIfAborted()
          const range = selectCompactableRange(
            agent.session,
            this.ctx.tokenMeter.measure(agent.session),
            0,
          )
          if (range === null) return null
          // An idle agent's next request takes the pending selection, so a
          // compaction right after a switch is written by the new model. The
          // route resolves inside the summary step: the opening marker is the
          // compaction lock and must be appended before anything is awaited.
          return await this.runPlanned(agent, { pending: true }, () => compactSurfaceRegion(
            this.regionDependencies(),
            agent.session,
            range.start,
            range.end,
            agent,
            {
              owner: null,
              stability: 'selected-span',
              ...sourceCommandId === undefined ? {} : { sourceCommandId },
              flush: async () => {
                await this.ctx.sessions.flush(agent.session)
              },
            },
            operationSignal,
          ))
        } catch (error: unknown) {
          if (agentSignal.aborted && operationSignal.reason === agentSignal.reason) {
            throw new ManualCompactionError(
              'cancelled',
              'manual compaction was cancelled',
              { cause: error },
            )
          }
          operationSignal.throwIfAborted()
          throw error
        }
      })
    } catch (error: unknown) {
      throw new ManualCompactionError(
        'busy',
        'manual compaction requires an idle agent with no waking queued work',
        { cause: error },
      )
    }
  }

  /** Bind the effective token meter and dynamically dispatched summarizer hook. */
  private regionDependencies(): Parameters<typeof compactSurfaceRegion>[0] {
    return {
      meter: this.ctx.tokenMeter,
      summarize: (input, owner, abort) => this.summarize(input, owner, abort),
      recover: (error, agent, sourceEventSeqs, signal) => this.ctx.waterfall('compaction/summary-error', {
        session: agent.session,
        sourceEventSeqs,
        error,
        ...signal === undefined ? {} : { signal },
      }, () => false),
    }
  }
}

export default BasicCompactionEngine
