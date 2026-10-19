/**
 * Harness Studio: the terminal chat's slash-command help and the status line printed after each reply.
 * @module @deepseek-ai/dsh-headless/chat-commands
 */

/** One command as the help lists it. */
export interface ChatCommandEntry {
  readonly name: string
  readonly description: string
  readonly input?: { readonly hint: string } | undefined
}

/** Commands the chat itself handles, before Harness's command registry. */
export const CHAT_COMMANDS: readonly ChatCommandEntry[] = [
  { name: 'help', description: 'List the commands' },
  { name: 'clear', description: 'Start a new session; the current one can still be continued with --session-id' },
  { name: 'model', description: 'Show the model this chat uses' },
  { name: 'exit', description: 'Quit (also Ctrl-D)' },
]

/**
 * The help text: the chat's own commands, then Harness's registered ones, each with its input hint.
 * @param registered - descriptors from Harness's command registry for the chat's agent.
 * @returns lines ready to print, ending with a newline.
 */
export function chatHelp(registered: readonly ChatCommandEntry[]): string {
  const own = new Set(CHAT_COMMANDS.map(command => command.name))
  const rows = [...CHAT_COMMANDS, ...registered.filter(command => !own.has(command.name))]
    .map(command => ({ usage: `/${command.name}${command.input === undefined ? '' : ` ${command.input.hint}`}`, description: command.description }))
  const width = Math.max(...rows.map(row => row.usage.length))
  return `${rows.map(row => `  ${row.usage.padEnd(width)}  ${row.description}`).join('\n')}\n`
}

/**
 * A token count in the short form a status line uses: 950, 12.3K, 1.2M.
 * @param count - tokens.
 * @returns the short form.
 */
export function shortTokens(count: number): string {
  if (count < 1000) return String(count)
  if (count < 1_000_000) return `${(count / 1000).toFixed(count < 10_000 ? 1 : 0)}K`
  return `${(count / 1_000_000).toFixed(1)}M`
}

/** What the status line shows; any part may be unknown. */
export interface ChatStatus {
  readonly model: string
  /** The last model request's prompt (including cached input) and output tokens. */
  readonly lastRequest?: { readonly input: number; readonly output: number } | undefined
  /** The prompt's share of the model's context window. */
  readonly context?: { readonly used: number; readonly window: number } | undefined
  /** The permission preset, such as workspace-write. */
  readonly permission?: string | undefined
}

/**
 * One line after each reply: model · last request in / out · context use · permission preset.
 * @param status - the parts that are known.
 * @returns the line, ending with a newline.
 */
export function statusLine(status: ChatStatus): string {
  const parts = [status.model]
  if (status.lastRequest !== undefined) parts.push(`${shortTokens(status.lastRequest.input)} in / ${shortTokens(status.lastRequest.output)} out`)
  if (status.context !== undefined && status.context.window > 0) parts.push(`context ${String(Math.round(100 * status.context.used / status.context.window))}%`)
  if (status.permission !== undefined) parts.push(status.permission)
  return `${parts.join(' · ')}\n`
}
