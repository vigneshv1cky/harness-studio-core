/** Chat-only row visibility; durable events and trajectory inspection remain intact. */
import type { ChatNode } from './chat-nodes.ts'

/** Marker the instructions producer writes when its byte budget left out or cut a file. */
const INSTRUCTION_BUDGET_MARKER = 'Workspace instruction budget '

/**
 * Whether a context message carries workspace instructions that the byte budget left out or cut.
 * @param data - the context message's durable content and source.
 * @returns true when the instructions producer recorded a budget cut.
 */
export function isCutInstructionsContext(data: Pick<Extract<ChatNode, { kind: 'context' }>['data'], 'content' | 'source'>): boolean {
  const source = data.source as { kind?: unknown } | null | undefined
  return source?.kind === 'agent-instructions'
    && data.content.some(block => block.type === 'text' && block.text.includes(INSTRUCTION_BUDGET_MARKER))
}

/**
 * Exclude system prompts, ordinary Context, and permission commands from visible Chat rows.
 * Context containing tool changes retains its notice row, and so do workspace
 * instructions that the byte budget left out or cut, so the user sees the cut.
 * @param node - projected Chat node.
 * @returns whether the node contributes a visible Chat row.
 */
export function isVisibleChatNode(node: ChatNode): boolean {
  return node.visibility === 'visible'
    && node.kind !== 'system-prompt'
    && (node.kind !== 'context'
      || node.data.content.some(block => block.type === 'tool-addition' || block.type === 'tool-removal')
      || isCutInstructionsContext(node.data))
    && !(node.kind === 'command' && node.data.name === 'permission')
}
