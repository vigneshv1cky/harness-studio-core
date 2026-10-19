# @deepseek-ai/dsh-terminal-chat

Harness Studio's full-screen terminal chat for the `harness-studio` command, drawn with [Ink](https://github.com/vadimdemedes/ink) in the style of Claude Code.

## What it shows

- A welcome box with the model and folder.
- The conversation in the terminal's own scrollback: your messages (`> …`), answers, and tool calls as `⏺ bash(List files)` with `⎿  Done` or the error's first line under them. Finished items are printed once and never redrawn, so the terminal's scrolling, search and copy keep working.
- A live area under them: tool calls still running, the answer as it is written, and a spinner with the elapsed time and the last line of reasoning.
- A bordered input box: Enter sends, a line ending in `\` continues on the next line, pasted text keeps its line breaks, ↑ and ↓ recall sent messages. Esc stops a reply; Ctrl-C stops a reply, clears the box, or quits on a second press within two seconds; Ctrl-D quits on an empty box.
- A footer with the status after each reply (model, tokens, context use, permission mode).
- A slash menu: typing `/` lists the commands under the box, narrowed by what follows; ↑ ↓ move, Tab completes, Enter runs the selected one.
- Approvals in a box in place of the input box: the tool, the reason, **1. Yes, once** and **2. No** (No selected); arrows and Enter, or the number, choose; Esc says no. The choice is echoed into the scrollback.
- Keys are split per press (`src/keys.ts`): Ink reads each chunk of input as one key, so keys arriving together, such as a held arrow key, would otherwise be lost.

## How it is used

The headless runner's chat loop (`@deepseek-ai/dsh-headless`) keeps the agent, commands and approvals. It opens this chat when stdin and stdout are terminals at least 40 columns wide, `TERM` is not `dumb` and `--plain` was not given; otherwise it keeps the plain line chat. Both implement the `ChatView` and `ChatInput` faces in `src/contract.ts`; text reaches the view already escaped, so model output cannot send control characters to the terminal.

`startTerminalChat()` turns on raw mode before the first frame, so typing during start-up is neither echoed over the frame nor held back until Enter, and hands Ctrl-C to the chat rather than to Ink.

## Tests

```sh
pnpm exec vitest run packages/ui/terminal-chat
```

`store.spec.ts` covers what lands in the scrollback, the input queue, questions, the choice box, the slash menu and every key. `keys.spec.ts` covers splitting input into presses. `app.spec.ts` draws the chat on a stand-in terminal and reads keys from it.

## Known Limitations and Deferred Work

- No rendered diffs, Markdown tables, `@` file mentions, pasted images, session picker, themes or vim keys.
- English only; this README has no Chinese edition.
