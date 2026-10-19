/** Composer text routed to the mounted question presentation. */
import { useEffect, useRef } from 'react'
import type { PendingQuestion, QuestionTypedReply } from './contract/slots.ts'

/**
 * Keep the newest render's handler registered for composer text while the card is mounted.
 * @param pending - card whose composer text the handler takes.
 * @param reply - applies the text to the question on screen.
 */
export function useTypedReply(pending: PendingQuestion, reply: QuestionTypedReply): void {
  const latest = useRef(reply)
  useEffect(() => { latest.current = reply })
  useEffect(() => pending.receiveTypedReplies(text => latest.current(text)), [pending])
}
