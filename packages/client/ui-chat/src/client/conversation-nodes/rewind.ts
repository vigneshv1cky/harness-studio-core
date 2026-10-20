import type { Context } from '@deepseek-ai/cordis'
import type {
  ConversationLocation, ConversationMatch, ConversationNodeDefinition,
} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { SessionEventLike } from '@deepseek-ai/dsh-api-session-controller/client'
import { chatNode, locationCoordinates } from './common.ts'

/** One in-place rewind: the empty step-0 `system/message` the Session Controller appends. */
export interface RewindNode {
  readonly kind: 'rewind'
  /** Seq of the replacement event. */
  readonly seq: number
  /** First rewound turn. */
  readonly turn: number
  /** Seq of the first surface node the rewind replaced. */
  readonly startSeq: number
}

declare module '../contract/chat-nodes.ts' {
  interface ChatNodeDataMap {
    /** Hidden marker of an in-place rewind; it hides the rewound turns' rows. */
    rewind: RewindNode
  }
}

function rewindOf(event: SessionEventLike): RewindNode | undefined {
  if (event.type !== 'system/message' || event.data.step !== 0 || event.data.message.content.length > 0) return undefined
  const surfaceOp = event.surfaceOp
  if (surfaceOp === 'append') return undefined
  return { kind: 'rewind', seq: event.seq, turn: event.data.turn, startSeq: surfaceOp.startSeq }
}

/** Marker Definition for in-place rewinds; the Chat ordering hides the rows it covers. */
export const rewindDefinition: ConversationNodeDefinition<RewindNode> = {
  kind: 'rewind',
  target: 'chat',
  match: event => rewindOf(event) === undefined ? null : { id: String(event.seq), role: 'start' },
  start: (_context, match: ConversationMatch) => {
    const node = rewindOf(match.event)
    if (node === undefined) throw new Error('rewind start requires an empty step-0 system/message replacement')
    return node
  },
  update: context => context.state,
  buildViewNode: context => context.state === undefined
    ? null
    : chatNode(context, 'rewind', context.state.seq, context.state, { visibility: 'hidden', location: { kind: 'session' } }),
}

/**
 * Hide the Chat rows of rewound turns: rows written before a rewind that belong
 * to its first rewound turn or a later one, or that follow its first replaced node.
 * @param nodes - materialized Chat Nodes, markers included.
 * @returns a predicate that is true for rows a rewind removed.
 */
export function rewoundRows(
  nodes: readonly { readonly kind: string; readonly data: unknown }[],
): (node: { readonly anchorSeq: number; readonly location: ConversationLocation }) => boolean {
  const rewinds = nodes.filter(node => node.kind === 'rewind').map(node => node.data as RewindNode)
  if (rewinds.length === 0) return () => false
  return node => rewinds.some((rewind) => {
    if (node.anchorSeq >= rewind.seq) return false
    const turn = locationCoordinates(node.location).turn
    return node.anchorSeq >= rewind.startSeq || (turn !== undefined && turn >= rewind.turn)
  })
}

/**
 * Register the in-place rewind marker contribution.
 * @param ctx - owning UI Conversation context.
 */
export function registerRewindConversationNode(ctx: Context): void {
  ctx.uiConversation.events.register(rewindDefinition)
}
