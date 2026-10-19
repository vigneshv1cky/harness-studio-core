import { useMemo, useRef, useState } from 'react'
import {
  Button, extractMarkdownPlainText, IconEditOutlineRegular, StateDot,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { PendingQuestion, PlanReview, QuestionComposerProps } from './contract/slots.ts'
import css from './PlanReviewPanel.module.css'
import { useTypedReply } from './typed-reply.ts'

/** The panel's own props: the question domain face, the narrowed review, and the locale seat. */
export type PlanReviewPanelProps =
  { pending: PendingQuestion; review: PlanReview } & Pick<QuestionComposerProps, 't' | 'renderSlot'>

/**
 * Optional-prop spread for a decision button's tooltip: `title` is optional on
 * the DOM props, and exactOptionalPropertyTypes rejects an explicit undefined.
 *
 * @param description - the asker's option description, when it carries one.
 * @returns The `title` prop to spread, or nothing.
 */
function tooltip(description: string | undefined): { title?: string } {
  return description === undefined ? {} : { title: description }
}

/**
 * Render plan review controls; the submitted document opens in the sidebar.
 *
 * @param props - the question domain face, the narrowed plan review, and `t`.
 * @returns The plan-review takeover for this request.
 */
export function PlanReviewPanel({ pending, review, t, renderSlot }: PlanReviewPanelProps) {
  // Foreground decisions wait for the resolved frame; accepted Remote decisions
  // hide the panel. A failed send re-enables the buttons and shows the error.
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const frame = useRef<HTMLDivElement>(null)
  /** Run one decision; resolves to the failure shown on the card, or null once it is sent. */
  const settle = (send: () => Promise<void>, remote = false): Promise<string | null> => {
    setBusy(true)
    setError(null)
    return send()
      .then(() => {
        if (!remote) return null
        setBusy(false)
        void pending.dismiss().catch(() => { setError(t('status.sent')) })
        return null
      }, (cause: unknown) => {
        const failure = cause instanceof Error ? cause.message : String(cause)
        setBusy(false)
        setError(failure)
        return failure
      })
  }
  const decide = (label: string): void => {
    void settle(() => pending.answer({ answers: [{ id: review.id, selected: [label] }] }), pending.snapshot().channel === 'rpc')
  }
  // Composer text is the change request: the plan's own free-text answer.
  useTypedReply(pending, async (text) => {
    if (busy) throw new Error(t('error.unavailable'))
    const failure = await settle(
      () => pending.answer({ answers: [{ id: review.id, selected: [], custom: text }] }),
      pending.snapshot().channel === 'rpc',
    )
    if (failure !== null) throw new Error(failure)
  })
  // The card stays while the user writes the change request in the composer.
  // A card that cannot take composer text, or a seat with no composer, closes as before.
  const requestChanges = (): void => {
    const composer = pending.composerReply === undefined
      ? null
      : frame.current?.closest('[data-conversation-content]')
        ?.querySelector<HTMLElement>('[data-composer-seat] [data-composer-input]')
    if (composer != null) {
      composer.focus()
      return
    }
    void settle(() => pending.dismiss())
  }
  const summary = useMemo(() => {
    const title = extractMarkdownPlainText(review.plan, { mode: 'first-line' })
    const description = extractMarkdownPlainText(review.plan, { mode: 'first-paragraph' })
    return { title, description: description === title ? '' : description }
  }, [review.plan])

  return (
    <div ref={frame} className={css.frame} data-plan-review-key={pending.key}>
      <section className={css.card} aria-label={review.question} aria-busy={busy}>
        <div className={css.strip}>
          <StateDot state={busy ? 'ongoing' : 'warning'} />
          {t('plan.header')}
          <div className={css.previewActions}>
            {renderSlot('conversation.plan-review.actions', { review, requestKey: pending.key })}
          </div>
        </div>
        <div className={css.summary}>
          <h3 className={css.title}>{summary.title}</h3>
          {summary.description !== '' && <p className={css.description}>{summary.description}</p>}
        </div>
        <div className={css.footer}>
          <div className={css.feedback} role="status">{error}</div>
          <div className={css.actions}>
            <Button
              variant="outline" className={css.discuss} icon={<IconEditOutlineRegular size={14} />}
              disabled={busy} onClick={requestChanges}
            >
              {t('plan.discuss')}
            </Button>
            <Button
              variant="primary" {...tooltip(review.approve.description)}
              disabled={busy} onClick={() => { decide(review.approve.label) }}
            >
              {t('plan.approve')}
            </Button>
          </div>
        </div>
      </section>
    </div>
  )
}
