/** Recording-bar language choice; it writes the same saved selection as the bundle details. */
import { useState } from 'react'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { IconChevronDownOutlineRegular, Menu } from '@deepseek-ai/dsh-client-ui-primitives'
import { NS } from './locales.ts'
import css from './VoiceInput.module.css'

/** Language hints with a full name in the dictionary; others show their code. */
const NAMED = ['auto', 'zh', 'en', 'yue', 'ja', 'ko'] as const

/** Props for one language menu in the recording bar. */
export interface LanguageMenuProps extends PropsLocale<typeof NS> {
  /** Hints the selected provider accepts, in its order. */
  languages: readonly string[]
  /** Hint the current recording will be recognized with. */
  value: string
  /** Whether the choice cannot change, such as while transcribing. */
  disabled?: boolean
  /** Report the chosen hint; the owner applies and saves it. */
  onChange: (language: string) => void
  /** Report whether the list is open, so Escape closes it instead of cancelling the recording. */
  onOpenChange: (open: boolean) => void
}

/** Render a compact chip naming the language, opening Harness's menu of the provider's languages. */
export function LanguageMenu({ languages, value, disabled = false, onChange, onOpenChange, t }: LanguageMenuProps) {
  const [open, setOpenState] = useState(false)
  const setOpen = (next: boolean): void => { setOpenState(next); onOpenChange(next) }
  const name = (language: string): string =>
    (NAMED as readonly string[]).includes(language) ? t(language as typeof NAMED[number]) : language
  const short = (language: string): string => language === 'auto' ? t('languageShort.auto') : name(language)
  return <Menu open={open} side="top" align="end" portal compact selectedId={value}
    items={languages.map(language => ({ id: language, label: name(language) }))}
    onSelect={(language) => { setOpen(false); if (language !== value) onChange(language) }}
    onClose={() => { setOpen(false) }}
    anchor={<button type="button" className={css.languageTrigger} disabled={disabled} data-voice-language={value}
      aria-label={t('languageMenu', { name: name(value) })} aria-haspopup="menu" aria-expanded={open}
      onMouseDown={(event) => { event.preventDefault() }} onClick={() => { setOpen(!open) }}>
      <span className={css.languageLabel}>{short(value)}</span>
      <span className={css.languageChevron} data-open={open || undefined} aria-hidden><IconChevronDownOutlineRegular /></span>
    </button>} />
}
