/**
 * The terminal chat's two faces, shared by the line chat and the full-screen chat: the input the chat loop reads
 * from, and the view it reports to. The chat loop (the headless runner) owns the agent; a view only draws.
 * @module @deepseek-ai/dsh-terminal-chat/contract
 */

/** Lines the person enters, read by the chat loop. */
export interface ChatInput extends AsyncIterable<string> {
  /** Ready for the next message (the line chat shows its prompt). */
  prompt(): void
  /** Run `listener` on Ctrl-C (and, in the full-screen chat, on Esc while a reply runs). */
  onInterrupt(listener: () => void): void
  /** Stop reading; the iteration then ends. */
  close(): void
  /**
   * Ask one question and read the answer. Only an answer entered after the question appeared counts: lines entered
   * earlier stay queued as messages, and text half-typed when it appears is cleared.
   * @param question - the question shown at the input.
   * @param signal - withdraws the question.
   * @returns the answer, or undefined when the question was withdrawn or input ended.
   */
  ask(question: string, signal?: AbortSignal): Promise<string | undefined>
}

/**
 * What the chat loop reports while it works. Text arrives already escaped: model and tool text cannot carry
 * control characters to the terminal.
 */
export interface ChatView {
  /** The chat opened: the model and folder it works in. */
  welcome(model: string, cwd: string): void
  /** A reply started. */
  replyStart(): void
  /** A model request started; `retry` when the previous attempt of the same step had already shown answer text. */
  attemptStart(retry: boolean): void
  /** Reasoning text as it streams. */
  reasoning(text: string): void
  /** Answer text as it streams. */
  answer(text: string): void
  /** A block of the reply ended (reasoning stops here). */
  blockEnd(): void
  /** A model request ended. */
  attemptEnd(): void
  /** A tool call started; `summary` says what it does in a few words. */
  toolCall(id: string, name: string, summary: string): void
  /** A tool call finished; `error` is its first line when it failed. */
  toolResult(id: string, name: string, error: string | undefined): void
  /**
   * The reply ended. `answer` is the whole answer when it was not streamed; `problem` says why the reply stopped
   * early, when it did.
   */
  replyEnd(answer: string | undefined, problem: string | undefined): void
  /** Text from the chat itself: command output, approval outcomes, errors. */
  notice(text: string): void
  /** The status after a reply: model, tokens, context use and permission mode. */
  status(line: string): void
  /** The chat closed; `sessionId` continues it with --session-id. */
  goodbye(sessionId: string): void
}
