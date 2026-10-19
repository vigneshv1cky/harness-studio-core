/**
 * The full-screen chat's state, kept outside React so the chat loop can report to it from anywhere: the scrollback
 * items (finished, never redrawn), the live part of the reply, the input box and the queue of entered lines.
 * @module @deepseek-ai/dsh-terminal-chat/store
 */

import type { ChatInput, ChatView } from './contract.ts'

/** One finished item, printed once into the terminal's scrollback. */
export type HistoryItem =
  | { readonly id: number; readonly kind: 'welcome'; readonly model: string; readonly cwd: string }
  | { readonly id: number; readonly kind: 'message'; readonly text: string }
  | { readonly id: number; readonly kind: 'answer'; readonly text: string }
  | { readonly id: number; readonly kind: 'tool'; readonly name: string; readonly summary: string; readonly error: string | undefined }
  | { readonly id: number; readonly kind: 'notice'; readonly text: string }

/** A history item before it is numbered. */
type NewHistoryItem = HistoryItem extends infer Item ? Item extends HistoryItem ? Omit<Item, 'id'> : never : never

/** A tool call still running, shown in the live area until its result arrives. */
export interface RunningTool {
  readonly id: string
  readonly name: string
  readonly summary: string
}

/** Everything the screen shows. */
export interface ChatState {
  readonly history: readonly HistoryItem[]
  /** The current model request's reasoning. */
  readonly reasoning: string
  /** Answer text streamed but not yet moved into the scrollback. */
  readonly answer: string
  readonly tools: readonly RunningTool[]
  /** When the reply in progress started (milliseconds), or undefined when idle. */
  readonly busySince: number | undefined
  readonly status: string
  /** The open question, shown above the input box. */
  readonly question: string | undefined
  /** The text in the input box. */
  readonly draft: string
  /** A short hint under the input box, such as the second-Ctrl-C reminder. */
  readonly hint: string | undefined
  readonly closed: boolean
}

/** How long the second Ctrl-C that quits may take. */
export const QUIT_WINDOW_MS = 2000

const INITIAL: ChatState = {
  history: [], reasoning: '', answer: '', tools: [], busySince: undefined, status: '', question: undefined, draft: '', hint: undefined, closed: false,
}

/** The keys the input box reacts to, as Ink reports them. */
export interface KeyPress {
  readonly return?: boolean
  readonly backspace?: boolean
  readonly delete?: boolean
  readonly escape?: boolean
  readonly upArrow?: boolean
  readonly downArrow?: boolean
  readonly ctrl?: boolean
  readonly meta?: boolean
  readonly tab?: boolean
}

/** The chat's state with the view and input the chat loop uses, and the key handling the input box uses. */
export class ChatStore {
  private state: ChatState = INITIAL
  private readonly listeners = new Set<() => void>()
  private nextId = 0
  private readonly queued: string[] = []
  private wake: (() => void) | undefined
  private answerQuestion: ((line: string | undefined) => void) | undefined
  private readonly interruptListeners: (() => void)[] = []
  private readonly sent: string[] = []
  private recall = 0
  /** When Ctrl-C was pressed on an empty, idle input box; a second press within {@link QUIT_WINDOW_MS} quits. */
  private quitArmedAt: number | undefined

  /**
   * @param now - the clock, replaceable in tests.
   */
  constructor(private readonly now: () => number = Date.now) {}

  /** The current state (a new object after every change). */
  readonly getSnapshot = (): ChatState => this.state

  /**
   * Observe changes.
   * @param listener - called after each change.
   * @returns the disposer.
   */
  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  private set(change: Partial<ChatState>): void {
    this.state = { ...this.state, ...change }
    for (const listener of this.listeners) listener()
  }

  private push(...items: NewHistoryItem[]): HistoryItem[] {
    return [...this.state.history, ...items.map(item => ({ ...item, id: this.nextId++ }) as HistoryItem)]
  }

  /** Move streamed answer text into the scrollback. */
  private settleAnswer(): void {
    if (this.state.answer.trim() === '') {
      if (this.state.answer !== '') this.set({ answer: '' })
      return
    }
    this.set({ history: this.push({ kind: 'answer', text: this.state.answer.replace(/\n+$/, '') }), answer: '' })
  }

  /** The view the chat loop reports to. */
  readonly view: ChatView = {
    welcome: (model, cwd) => { this.set({ history: this.push({ kind: 'welcome', model, cwd }) }) },
    replyStart: () => { this.set({ busySince: this.now(), reasoning: '' }) },
    attemptStart: (retry) => {
      this.settleAnswer()
      this.set({ reasoning: '', ...retry ? { history: this.push({ kind: 'notice', text: '(retrying)' }) } : {} })
    },
    reasoning: (text) => { this.set({ reasoning: this.state.reasoning + text }) },
    answer: (text) => { this.set({ answer: this.state.answer + text }) },
    blockEnd: () => {},
    attemptEnd: () => {
      this.settleAnswer()
      this.set({ reasoning: '' })
    },
    toolCall: (id, name, summary) => {
      this.settleAnswer()
      this.set({ tools: [...this.state.tools, { id, name, summary }] })
    },
    toolResult: (id, name, error) => {
      const running = this.state.tools.find(tool => tool.id === id)
      this.set({
        tools: this.state.tools.filter(tool => tool.id !== id),
        history: this.push({ kind: 'tool', name: running?.name ?? name, summary: running?.summary ?? '', error }),
      })
    },
    replyEnd: (answer, problem) => {
      if (answer !== undefined && answer !== '') this.set({ answer: this.state.answer + answer })
      this.settleAnswer()
      this.set({
        busySince: undefined, reasoning: '', tools: [],
        ...problem === undefined ? {} : { history: this.push({ kind: 'notice', text: problem }) },
      })
    },
    notice: (text) => {
      this.settleAnswer()
      this.set({ history: this.push({ kind: 'notice', text: text.replace(/\n+$/, '') }) })
    },
    status: (line) => { this.set({ status: line.replace(/\n+$/, '') }) },
    goodbye: (sessionId) => { this.set({ history: this.push({ kind: 'notice', text: `Session ${sessionId}; continue it with --session-id ${sessionId}` }) }) },
  }

  /** The input the chat loop reads. */
  readonly input: ChatInput = {
    [Symbol.asyncIterator]: () => this.lines(),
    prompt: () => {},
    onInterrupt: (listener) => { this.interruptListeners.push(listener) },
    close: () => { this.close() },
    ask: (question, signal) => {
      if (this.state.closed || signal?.aborted === true) return Promise.resolve(undefined)
      // The question clears the box: nothing typed before it appeared can answer it.
      this.set({ question, draft: '' })
      return new Promise((resolve) => {
        const finish = (line: string | undefined): void => {
          signal?.removeEventListener('abort', withdraw)
          this.set({ question: undefined })
          resolve(line)
        }
        const withdraw = (): void => {
          if (this.answerQuestion === finish) this.answerQuestion = undefined
          finish(undefined)
        }
        this.answerQuestion = finish
        signal?.addEventListener('abort', withdraw, { once: true })
      })
    },
  }

  private async* lines(): AsyncGenerator<string> {
    while (true) {
      const line = this.queued.shift()
      if (line !== undefined) {
        yield line
        continue
      }
      if (this.state.closed) return
      await new Promise<void>((resolve) => { this.wake = resolve })
      this.wake = undefined
    }
  }

  /** End the chat: the loop's iteration ends and an open question answers nothing. */
  close(): void {
    if (this.state.closed) return
    this.set({ closed: true })
    const settle = this.answerQuestion
    this.answerQuestion = undefined
    settle?.(undefined)
    this.wake?.()
  }

  private interrupt(): void {
    for (const listener of this.interruptListeners) listener()
  }

  /** Enter: answer the open question, or send the line. */
  private submit(): void {
    const line = this.state.draft
    this.recall = 0
    if (this.state.question !== undefined && this.answerQuestion !== undefined) {
      const settle = this.answerQuestion
      this.answerQuestion = undefined
      this.set({ draft: '', history: this.push({ kind: 'notice', text: `${this.state.question} ${line}` }) })
      settle(line)
      return
    }
    if (line.trim() === '') return
    this.sent.push(line)
    this.set({ draft: '', history: this.push({ kind: 'message', text: line }) })
    this.queued.push(line.trim())
    this.wake?.()
  }

  /**
   * One key or pasted chunk in the input box. Enter sends; a line ending in `\` continues on a new line; a paste
   * keeps its line breaks; ↑ and ↓ step through sent messages; Esc stops a reply; Ctrl-C stops a reply or quits;
   * Ctrl-D quits.
   * @param input - the typed or pasted text.
   * @param key - which special key, if any.
   */
  key(input: string, key: KeyPress): void {
    if (this.state.closed) return
    if (key.ctrl === true && input === 'c') {
      // While a reply runs Ctrl-C stops it; otherwise it clears the box, and on an empty box a second press quits.
      if (this.state.busySince !== undefined) this.interrupt()
      else if (this.state.draft !== '') this.set({ draft: '' })
      else if (this.quitArmedAt !== undefined && this.now() - this.quitArmedAt <= QUIT_WINDOW_MS) this.interrupt()
      else {
        this.quitArmedAt = this.now()
        this.set({ hint: 'Press Ctrl-C again to quit' })
      }
      return
    }
    if (this.state.hint !== undefined) this.set({ hint: undefined })
    this.quitArmedAt = undefined
    if (key.ctrl === true && input === 'd') {
      if (this.state.draft === '') this.close()
      return
    }
    if (key.escape === true) {
      if (this.state.busySince !== undefined) this.interrupt()
      return
    }
    if (key.return === true) {
      if (this.state.draft.endsWith('\\')) this.set({ draft: `${this.state.draft.slice(0, -1)}\n` })
      else this.submit()
      return
    }
    if (key.backspace === true || key.delete === true) {
      this.set({ draft: this.state.draft.slice(0, -1) })
      return
    }
    if (key.upArrow === true || key.downArrow === true) {
      if (this.state.question !== undefined || this.sent.length === 0) return
      this.recall = Math.min(this.sent.length, Math.max(0, this.recall + (key.upArrow === true ? 1 : -1)))
      this.set({ draft: this.recall === 0 ? '' : this.sent[this.sent.length - this.recall] ?? '' })
      return
    }
    if (key.ctrl === true || key.meta === true || key.tab === true || input === '') return
    // One line arriving together with Enter is typing that came in faster than it was read: it sends.
    if (/^[^\r\n]+\r$/.test(input)) {
      this.set({ draft: this.state.draft + input.slice(0, -1) })
      this.submit()
      return
    }
    // A pasted chunk arrives at once; its line breaks stay in the message instead of sending it.
    this.set({ draft: this.state.draft + input.replace(/\r\n?/g, '\n') })
  }
}
