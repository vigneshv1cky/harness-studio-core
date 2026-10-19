/** Desktop welcome presentation; Harness Studio's only first-launch action is choosing a model provider. */
import { useEffect, useRef, useState } from 'react'
import { Toast } from '@deepseek-ai/dsh-client-ui-primitives/src/Toast.tsx'
import type { WelcomeApi } from '../welcome-api.ts'

/**
 * Render the standalone welcome page using shell-owned operations and localized copy. It shows
 * whenever no provider credential is configured; "Choose a model provider" opens the workspace on
 * Settings → Models, which lists every provider Harness supports. There is no account sign-in.
 * @param props.api - isolated preload API; no credentials reach the renderer.
 * @returns the welcome page with its single action.
 */
export function Welcome({ api }: { api: WelcomeApi }) {
  const { messages: m } = api
  const [expiryNotice, setExpiryNotice] = useState(false)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const busyRef = useRef(false)
  const mounted = useRef(true)

  useEffect(() => {
    mounted.current = true
    document.documentElement.lang = api.id
    document.title = m.welcomeTitle
    const takeNotice = (): void => {
      void api.takeNotice().then((notice) => {
        if (mounted.current && notice === 'session-expired') setExpiryNotice(true)
      }).catch((_closedChannel: unknown) => {
        // A closed Welcome IPC channel must not interrupt the welcome page.
      })
    }
    takeNotice()
    const stop = api.onAccountState(() => { takeNotice() })
    return () => { mounted.current = false; stop() }
  }, [api, m.welcomeTitle])

  /** Open the workspace on Settings → Models. */
  async function chooseProvider() {
    if (busyRef.current) return
    busyRef.current = true
    setBusy(true)
    setError('')
    try {
      await api.skip()
    } catch {
      if (mounted.current) setError(m.welcomeContinueFailed)
    } finally {
      busyRef.current = false
      if (mounted.current) setBusy(false)
    }
  }

  return <>
    {expiryNotice && <Toast text={m.welcomeSessionExpired} onDone={() => { setExpiryNotice(false) }} />}
    <div className="titlebar" aria-hidden="true" />
    <main className="welcome" aria-labelledby="welcome-heading">
      <img className="brand" src="assets/welcome-brand.svg" alt={m.welcomeBrand} width="472" height="40" />
      <div id="tagline" className="tagline">
        <h1 id="welcome-heading"><span>{m.welcomeTaglineBefore}</span><em>{m.welcomeTaglineBrand}</em><span>{m.welcomeTaglineAfter}</span></h1>
        <p id="welcome-description">{m.welcomeDescription}</p>
        <p id="entry-error" className="key-error" role="alert" hidden={error === ''}>{error}</p>
      </div>
      <div id="entry-actions" className="actions">
        <button id="choose-provider" className="primary" type="button" disabled={busy} onClick={() => { void chooseProvider() }}>{m.welcomeChooseProvider}</button>
      </div>
    </main>
  </>
}
