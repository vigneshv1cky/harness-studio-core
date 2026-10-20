/** Session projection and selection for aging tool-result images out of requests. */

import { z as zod } from 'zod'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { isReplacementSurfaceEvent, SessionSeq } from '@deepseek-ai/dsh-session'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import type { ImageOffloadTarget } from './projection.ts'

/** Session projection key of the tool-image age state. */
export const TOOL_IMAGE_AGE_KEY = 'toolImageAge'

const toolImageAgeStateSchema = zod.object({
  /** Count of `assistant/message` events committed so far. */
  responses: zod.number().int().nonnegative(),
  /** Tool-result nodes that still carry images not yet offloaded, in commit order. */
  retained: zod.array(zod.object({
    /** The `tool/result` event carrying the images. */
    seq: zod.number().int().nonnegative(),
    /** `responses` when the images first arrived; a replacement inherits its source's value. */
    at: zod.number().int().nonnegative(),
    /** Depth-first indexes of the images not yet offloaded. */
    imageIndexes: zod.array(zod.number().int().nonnegative()).min(1),
  })),
})

/** Plain-JSON fold state of {@link TOOL_IMAGE_AGE_KEY}. */
export type ToolImageAgeState = zod.infer<typeof toolImageAgeStateSchema>

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap {
    /** Retained tool-result images and the model-response count that ages them. */
    toolImageAge: ToolImageAgeState
  }
}

/** Depth-first indexes of the images in `content` not marked offloaded. */
function retainedImageIndexes(content: readonly ContentBlock[]): number[] {
  const indexes: number[] = []
  let imageIndex = 0
  for (const block of content) {
    if (block.type !== 'image') continue
    if (block.offloaded !== true) indexes.push(imageIndex)
    imageIndex += 1
  }
  return indexes
}

/**
 * Fold one committed event into the age state. Replacements drop their sources
 * and a replacing `tool/result` keeps the earliest source arrival; an
 * `image/offload` removes the indexes it selects.
 * @param state - state covering every earlier event.
 * @param event - the next committed event.
 * @returns the next state, or `state` itself when the event changes nothing.
 */
function applyToolImageAge(state: ToolImageAgeState, event: SessionEvent): ToolImageAgeState {
  if (event.type === 'assistant/message') return { ...state, responses: state.responses + 1 }
  if (event.type === 'image/offload') {
    const selected = new Map(event.data.targets.map(target => [target.seq as number, new Set(target.imageIndexes)]))
    if (!state.retained.some(entry => selected.has(entry.seq))) return state
    return {
      ...state,
      retained: state.retained.flatMap((entry) => {
        const omitted = selected.get(entry.seq)
        if (omitted === undefined) return [entry]
        const imageIndexes = entry.imageIndexes.filter(index => !omitted.has(index))
        return imageIndexes.length === 0 ? [] : [{ ...entry, imageIndexes }]
      }),
    }
  }
  let retained = state.retained
  let inherited: number | undefined
  if (isReplacementSurfaceEvent(event)) {
    const sources = new Set<number>(event.sourceEventSeqs)
    const kept = retained.filter(entry => !sources.has(entry.seq))
    for (const entry of retained) {
      if (sources.has(entry.seq)) inherited = Math.min(inherited ?? entry.at, entry.at)
    }
    if (kept.length !== retained.length) retained = kept
  }
  if (event.type === 'tool/result') {
    const imageIndexes = retainedImageIndexes(event.data.message.content)
    if (imageIndexes.length > 0) retained = [...retained, { seq: event.seq, at: inherited ?? state.responses, imageIndexes }]
  }
  return retained === state.retained ? state : { ...state, retained }
}

/** Host-only projection unit tracking which tool-result images are still sent. */
export const toolImageAgeProjection: ProjectionDefinition<typeof TOOL_IMAGE_AGE_KEY> = {
  key: TOOL_IMAGE_AGE_KEY,
  stateVersion: 1,
  stateSchema: toolImageAgeStateSchema,
  init: () => ({ responses: 0, retained: [] }),
  apply: applyToolImageAge,
}

/**
 * Record one decision omitting every retained tool-result image that at least
 * `maxAgeSteps` model responses follow. User-message images are never selected.
 * Every retained entry is a current surface node: replacements remove their sources.
 * @param session - session whose next request applies the decision.
 * @param state - the session's current {@link TOOL_IMAGE_AGE_KEY} state.
 * @param maxAgeSteps - positive count of later model responses that ages an image out.
 * @returns whether any occurrence was selected.
 */
export function offloadAgedToolImages(session: Session, state: ToolImageAgeState, maxAgeSteps: number): boolean {
  const targets: ImageOffloadTarget[] = state.retained
    .filter(entry => state.responses - entry.at >= maxAgeSteps)
    .map(entry => ({ seq: SessionSeq(entry.seq), imageIndexes: [...entry.imageIndexes] }))
  if (targets.length === 0) return false
  session.append('image/offload', { targets })
  return true
}
