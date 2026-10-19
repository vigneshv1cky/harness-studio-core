/**
 * The full-screen chat's Ink components. Finished items go into the terminal's scrollback through Ink's `Static`
 * and are never redrawn; only the live area (running tools, the answer being written, the spinner), the input box
 * and the footer are redrawn. Elements are built with `createElement` because Host packages compile without JSX.
 * @module @deepseek-ai/dsh-terminal-chat/app
 */

import { createElement as h, Fragment, useEffect, useState, useSyncExternalStore, type ReactElement } from 'react'
import { Box, Static, Text, useStdin } from 'ink'
import { splitKeys } from './keys.ts'
import { menuFor, type ChatState, type ChatStore, type HistoryItem } from './store.ts'

/** The spinner's frames, drawn about ten times a second while a reply runs. */
export const SPINNER = ['·', '✢', '✳', '✶', '✻', '✽', '✻', '✶', '✳', '✢']

/** How long a reply has been running, as the spinner shows it: 8s, 1m 05s. */
export function elapsed(milliseconds: number): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000))
  if (seconds < 60) return `${String(seconds)}s`
  return `${String(Math.floor(seconds / 60))}m ${String(seconds % 60).padStart(2, '0')}s`
}

/** The last non-empty line of reasoning, shown dim beside the spinner. */
export function lastLine(text: string, width = 80): string {
  const line = text.split('\n').map(part => part.trim()).filter(Boolean).at(-1) ?? ''
  return line.length > width ? `${line.slice(0, width - 1)}…` : line
}

function Item({ item }: { item: HistoryItem }): ReactElement {
  switch (item.kind) {
    case 'welcome':
      return h(Box, { borderStyle: 'round', borderColor: 'cyan', paddingX: 1, flexDirection: 'column' },
        h(Text, null, h(Text, { color: 'cyan' }, '✻ '), h(Text, { bold: true }, 'Harness Studio')),
        h(Text, { dimColor: true }, `${item.model} · ${item.cwd}`),
        h(Text, { dimColor: true }, '/ for commands · Esc stops a reply · Ctrl-C twice quits'))
    case 'message':
      return h(Box, { marginTop: 1 }, h(Text, { dimColor: true }, '> '), h(Text, null, item.text))
    case 'answer':
      return h(Box, { marginTop: 1 }, h(Text, null, item.text))
    case 'tool':
      return h(Box, { flexDirection: 'column', marginTop: 1 },
        h(Text, null, h(Text, { color: item.error === undefined ? 'green' : 'red' }, '⏺ '), h(Text, { bold: true }, item.name),
          item.summary === '' ? '' : h(Text, { dimColor: true }, `(${item.summary})`)),
        h(Text, item.error === undefined ? { dimColor: true } : { color: 'red' }, `  ⎿  ${item.error ?? 'Done'}`))
    case 'notice':
      return h(Box, null, h(Text, { dimColor: true }, item.text))
    /* v8 ignore next -- closed-union exhaustiveness guard */
    default:
      return h(Fragment)
  }
}

function Spinner({ since, reasoning }: { since: number; reasoning: string }): ReactElement {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    const timer = setInterval(() => { setNow(Date.now()) }, 100)
    return () => { clearInterval(timer) }
  }, [])
  const frame = SPINNER[Math.floor(now / 100) % SPINNER.length] ?? '✻'
  const thought = lastLine(reasoning)
  return h(Box, { marginTop: 1, flexDirection: 'column' },
    h(Text, null, h(Text, { color: 'cyan' }, `${frame} `), h(Text, null, reasoning === '' ? 'Working… ' : 'Thinking… '),
      h(Text, { dimColor: true }, `${elapsed(now - since)} · Esc to stop`)),
    thought === '' ? null : h(Text, { dimColor: true, wrap: 'truncate-end' }, `  ${thought}`))
}

function Live({ state }: { state: ChatState }): ReactElement {
  return h(Box, { flexDirection: 'column' },
    ...state.tools.map(tool => h(Box, { key: tool.id, flexDirection: 'column', marginTop: 1 },
      h(Text, null, h(Text, { color: 'yellow' }, '⏺ '), h(Text, { bold: true }, tool.name),
        tool.summary === '' ? '' : h(Text, { dimColor: true }, `(${tool.summary})`)),
      h(Text, { dimColor: true }, '  ⎿  Running…'))),
    state.answer === '' ? null : h(Box, { marginTop: 1 }, h(Text, null, state.answer)),
    state.busySince === undefined ? null : h(Spinner, { since: state.busySince, reasoning: state.reasoning }))
}

function ChoiceBox({ choice }: { choice: NonNullable<ChatState['choice']> }): ReactElement {
  return h(Box, { flexDirection: 'column', marginTop: 1 },
    h(Box, { borderStyle: 'round', borderColor: 'yellow', paddingX: 1, flexDirection: 'column' },
      h(Text, { bold: true }, choice.title),
      choice.detail === undefined ? null : h(Text, { dimColor: true }, choice.detail),
      h(Box, { flexDirection: 'column', marginTop: 1 },
        ...choice.options.map((option, index) => h(Text, { key: option.value, ...index === choice.selected ? { color: 'cyan' } : {} },
          `${index === choice.selected ? '❯' : ' '} ${String(index + 1)}. ${option.label}`)))),
    h(Box, { paddingX: 2 }, h(Text, { dimColor: true }, '↑↓ to choose · Enter to confirm · Esc to say no')))
}

function Menu({ entries, selected }: { entries: ReturnType<typeof menuFor>; selected: number }): ReactElement {
  // The name column fits the names; a command's input hint shows only beside the selected entry.
  const width = Math.max(...entries.map(entry => entry.name.length)) + 1
  const active = Math.min(selected, entries.length - 1)
  return h(Box, { flexDirection: 'column', paddingX: 2 },
    ...entries.map((entry, index) => {
      const label = `/${entry.name}${index === active && entry.input !== undefined ? ` ${entry.input.hint}` : ''}`
      return h(Text, { key: entry.name, wrap: 'truncate-end' },
        h(Text, index === active ? { color: 'cyan' } : {}, `${index === active ? '❯ ' : '  '}${label.padEnd(width + 1)}`),
        h(Text, { dimColor: true }, ` ${entry.description}`))
    }))
}

function Input({ state }: { state: ChatState }): ReactElement {
  if (state.choice !== undefined) return h(ChoiceBox, { choice: state.choice })
  const lines = state.draft.split('\n')
  const menu = menuFor(state)
  return h(Box, { flexDirection: 'column', marginTop: 1 },
    state.question === undefined ? null : h(Text, { color: 'yellow' }, state.question),
    h(Box, { borderStyle: 'round', borderColor: state.question === undefined ? 'gray' : 'yellow', paddingX: 1, flexDirection: 'column' },
      ...lines.map((line, index) => h(Text, { key: String(index) },
        h(Text, { dimColor: true }, index === 0 ? '> ' : '  '), line,
        index === lines.length - 1 ? h(Text, { inverse: true }, ' ') : ''))),
    menu.length > 0 ? h(Menu, { entries: menu, selected: state.menuIndex }) : h(Box, { paddingX: 2, justifyContent: 'space-between' },
      h(Text, { dimColor: true }, state.hint ?? state.status),
      h(Text, { dimColor: true }, state.question === undefined ? '/ for commands' : '')))
}

/**
 * Read keys from Ink's raw input, split into one press per key: Ink's own `useInput` treats each chunk as one key,
 * so keys arriving together would be lost.
 */
function useKeys(store: ChatStore): void {
  const { setRawMode, internal_eventEmitter: input } = useStdin()
  useEffect(() => {
    setRawMode(true)
    return () => { setRawMode(false) }
  }, [setRawMode])
  useEffect(() => {
    const onData = (data: string): void => {
      for (const [text, key] of splitKeys(data)) store.key(text, key)
    }
    input.on('input', onData)
    return () => { input.removeListener('input', onData) }
  }, [input, store])
}

/** The whole chat screen over one store. */
export function TerminalChatApp({ store }: { store: ChatStore }): ReactElement {
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot)
  useKeys(store)
  return h(Fragment, null,
    h(Static<HistoryItem>, { items: [...state.history], children: (item: HistoryItem) => h(Item, { key: item.id, item }) }),
    state.closed ? null : h(Live, { state }),
    state.closed ? null : h(Input, { state }))
}
