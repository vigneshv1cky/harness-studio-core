/**
 * The text preview's body: a file's content, or the reason it is not showing.
 *
 * Two sources meet here. The standard `useResource` hook gives the file's
 * metadata — its version — and this type's
 * own store holds the content it read through its face. Metadata changes reload
 * the current preview while automatic refresh is enabled. A failed metadata frame — the file gone, its
 * workspace unknown — takes the same bar's place over the pages already loaded,
 * with the same reload. The type's controls, viewer choice, wrap and reload, sit at the end of
 * the path row; the Sidebar's strip carries none of them.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import clsx from 'clsx'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { FactoryComponentPropsOf, PropsRenderFactories, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { UseSidebarRightTabInfo } from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import {
  FileTypeIcon, IconNowrapFillRegular, IconPauseOutlineRegular, IconPlayOutlineRegular,
  IconRefreshOutlineRegular, IconWrapFillRegular, Menu, PathLabel, Tooltip, classifyFileType,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { pathPartsOf } from '@deepseek-ai/dsh-util-workspace-path'
import type { TextInjected } from './face.ts'
import { emptyFailureRecourse, failureLine } from './failure-line.ts'
import { LoadingIndicator } from './LoadingIndicator.tsx'
import { hostFileOf } from './rpc.ts'
import type { DocumentContent } from './document/contract.ts'
import { binaryDocumentPath, matchingDocumentPreviews } from './document/registry.ts'
import type { DocumentPreviewDefinition } from './document/registry.ts'
import { unviewableBinaryPath } from './document/unviewable.ts'
import { PLAIN_BODY_ID } from './text/index.ts'
import { CODE_BODY_ID } from './code/index.ts'
import { MARKDOWN_BODY_ID } from './markdown/index.ts'
import { loadedPages, lastLineLoaded, scrollToLine } from './text/lines.ts'
import css from './TextPreview.module.css'

export { linesOf, loadedPages, lastLineLoaded, scrollToLine } from './text/lines.ts'
export type { LoadedPage } from './text/lines.ts'

/** Markdown files open in the reader's last choice: rendered, or their source. */
export type MarkdownView = 'rendered' | 'source'

/**
 * Browser storage key for that choice. Harness Studio's Files tab reads and writes the same key, so
 * one choice applies to both places a Markdown file opens.
 */
export const MARKDOWN_VIEW_KEY = 'harness-studio.markdown-view'

/** @returns the remembered Markdown view; rendered when none is stored or storage is unavailable. */
export function readMarkdownView(): MarkdownView {
  try { return globalThis.localStorage?.getItem(MARKDOWN_VIEW_KEY) === 'source' ? 'source' : 'rendered' } catch { return 'rendered' }
}

/** @param view - the choice to remember; storage failures leave it for this tab only. */
function writeMarkdownView(view: MarkdownView): void {
  try { globalThis.localStorage?.setItem(MARKDOWN_VIEW_KEY, view) } catch { /* private storage: not remembered */ }
}

/** Private registration inputs; the framework binds the registry source to useDocumentPreviews. */
export interface TextPreviewInjected extends TextInjected {
  readonly hooks: { readonly documentPreviews: ObservableSnapshot<readonly DocumentPreviewDefinition[]> }
}

/** The preview Factory's caller input: tab information for the file shown. */
export interface DocumentPreviewInput {
  /**
   * Read the shown file's tab information. The right Sidebar passes its own tab's reader; a host that embeds the
   * preview passes its tab's information with the shown file's `id`, `contentId`, `title`, `navigation`, `signal`
   * and command binding. The `id` keys the preview's per-file state, which ends when `signal` aborts.
   */
  readonly useTabInfo: UseSidebarRightTabInfo
  /** Path the header shows in place of the Host's absolute path, such as one relative to the host's own folder. */
  readonly displayPath?: string | undefined
}

/** The body's composed props: the tab, its navigation, the shared store and face, and copy. */
export type TextPreviewProps = FactoryComponentPropsOf<'sidebar.right.document.preview'>

/**
 * The text type's tab body: the preview Factory for this tab's own file.
 * @param props - the tab's runtime props.
 * @returns the preview occurrence.
 */
export function TextPreviewTab({ useTabInfo, renderFactorySlot }: PropsRuntime<'sidebar.right.pane.tab'> & PropsRenderFactories): ReactNode {
  return renderFactorySlot('sidebar.right.document.preview', { useTabInfo })
}

/**
 * The file preview: the `sidebar.right.document.preview` Factory, shown by the text type's tab body and by hosts
 * that embed a file preview.
 * @param props - composed slot props.
 * @returns the content read so far with its controls, or a progress line.
 */
export function TextPreview({
  useTabInfo, useResource, useStore, actions, loadPage, reloadPages,
  loadAll, reloadAll, prepareRenderer, useDocumentPreviews, renderSlot, t,
  addResource, setResources, displayPath: shownPath,
}: TextPreviewProps): ReactNode {
  const { tab } = useTabInfo()
  const { navigation, signal } = tab
  const meta = useResource<'file'>(tab.contentId)
  const canRead = meta.status !== 'none'
  const file = useMemo(() => hostFileOf(tab.contentId), [tab.contentId])
  const state = useStore(s => s.byTab[tab.id])
  const definitions = useDocumentPreviews(value => value)
  const unviewable = useMemo(() => unviewableBinaryPath(file.path), [file.path])
  const candidates = useMemo(() => {
    const matched = matchingDocumentPreviews(definitions, file.path)
    if (matched.length > 0 && binaryDocumentPath(definitions, file.path)) return matched
    if (matched.length === 0 && unviewable) return matched
    const fallback = definitions.find(definition => definition.id === PLAIN_BODY_ID)
    return fallback === undefined ? matched : [...matched, fallback]
  }, [definitions, file.path, unviewable])
  // A Markdown file offers a Rendered / Source switch in place of the viewer menu: the Markdown renderer,
  // and the highlighted code viewer (plain text when that is missing). A tab with no manual choice opens
  // in the remembered view. A higher-ranked extension viewer keeps the menu and its default.
  const markdownViews = useMemo(() => {
    const rendered = candidates[0]?.id === MARKDOWN_BODY_ID ? candidates[0] : undefined
    const source = candidates.find(candidate => candidate.id === CODE_BODY_ID) ?? candidates.find(candidate => candidate.id === PLAIN_BODY_ID)
    return rendered === undefined || source === undefined ? undefined : { rendered, source }
  }, [candidates])
  const [markdownView, setMarkdownView] = useState(readMarkdownView)
  const selected = candidates.find(candidate => candidate.id === state?.rendererId) ?? markdownViews?.[markdownView] ?? candidates[0]
  const mode = selected?.loading
  const contentRendererId = mode === 'renderer' ? selected?.id : undefined
  const current = (state?.mode ?? 'text-pages') === mode && state?.contentRendererId === contentRendererId ? state : undefined
  const add = useCallback((address: string) => {
    addResource(tab.id, address, signal)
  }, [addResource, tab.id, signal])
  const set = useCallback((addresses: readonly string[]) => {
    setResources(tab.id, [tab.contentId, ...addresses], signal)
  }, [setResources, tab.id, tab.contentId, signal])
  useEffect(() => {
    set([])
  }, [set, selected?.id])
  const bodyRef = useRef<HTMLDivElement | null>(null)
  const scrollportRef = useRef<HTMLElement | null>(null)
  const storedScrollTopRef = useRef(0)
  const [menuOpen, setMenuOpen] = useState(false)
  const absolutePath = meta.value?.absolutePath ?? current?.complete?.absolutePath
  const displayPath = shownPath ?? absolutePath ?? file.path
  // Contributions that hand the file to the Host wait for its Host path.
  const fileOwner = absolutePath === undefined ? undefined : { absolutePath }
  // Every tab of this type is a `file` resource address, so its params are the
  // `file` type's; the union is narrowed on the one field read, not validated.
  const line = navigation.params !== undefined && 'line' in navigation.params ? navigation.params.line : undefined
  const pages = current?.pages
  const loaded = useMemo(() => loadedPages(pages ?? {}), [pages])
  const loadedThrough = lastLineLoaded(loaded)
  const hasContent = mode === 'renderer' ? current?.version !== undefined : loaded.length > 0 || current?.complete !== undefined
  storedScrollTopRef.current = state?.scrollTop ?? 0
  const bindBody = useCallback((body: HTMLDivElement | null): void => {
    const previous = bodyRef.current
    bodyRef.current = body
    if (scrollportRef.current === null || scrollportRef.current === previous) scrollportRef.current = body
  }, [])
  const bindScrollport = useCallback((scrollport: HTMLElement | null): void => {
    const next = scrollport ?? bodyRef.current
    scrollportRef.current = next
    if (next !== null) next.scrollTop = storedScrollTopRef.current
  }, [])

  // First mount reads the first page; a body coming back to a tab with content
  // reads nothing, because the store outlives the body.
  const started = current !== undefined
  useEffect(() => {
    if (started || !canRead || mode === undefined || selected === undefined) return
    if (mode === 'text-pages') loadPage(tab.id, file, 1, signal, meta.value?.version)
    else if (mode === 'bytes-complete') loadAll(tab.id, file, signal, meta.value?.version)
    else prepareRenderer(tab.id, signal, selected.id, meta.value?.version)
  }, [started, tab.id, file, signal, loadPage, loadAll, prepareRenderer, canRead, mode, selected, meta.value?.version])

  // Come back where the reader was once there is content to scroll: on a remount,
  // after a reload rebuilt the content, or after the selected renderer changed.
  // Scroll writes preserve both identities, so they never re-land.
  useEffect(() => {
    const body = scrollportRef.current
    if (hasContent && body !== null && state !== undefined) body.scrollTop = state.scrollTop
  }, [hasContent, selected?.id])

  // Answer a navigation once: a line the pages do not reach yet loads the next
  // page (again, until the pages cover it or the file ends); a line they hold
  // is scrolled to and marked. The store remembers the answer, so a remount
  // restores the reader's place instead.
  useEffect(() => {
    const body = scrollportRef.current
    if (current === undefined || body === null || current.revision === navigation.revision) return
    if (line === undefined || mode !== 'text-pages') {
      actions.navigated(tab.id, navigation.revision)
      return
    }
    if (line > loadedThrough && !current.eof) {
      if (!current.loading && current.failure === undefined && canRead) {
        loadPage(tab.id, file, loadedThrough + 1, signal, meta.value?.version)
      }
      return
    }
    const landed = scrollToLine(body, line)
    if (!landed && line <= loadedThrough) return
    actions.navigated(tab.id, navigation.revision)
    // Recorded here as well as by the scroll event, so the store holds the
    // landing before any later navigation reads it.
    actions.scrolled(tab.id, body.scrollTop)
  }, [
    navigation.revision, line, loadedThrough, current?.eof, current?.loading, current?.failure, started,
    selected?.id, mode, file, canRead, meta.value?.version,
  ])

  const rendererReload = useCallback((): void => {
    if (canRead && selected !== undefined) prepareRenderer(tab.id, signal, selected.id, meta.value?.version, true)
  }, [canRead, prepareRenderer, tab.id, signal, selected?.id, meta.value?.version])
  const observedVersion = meta.value?.version
  const changed = (current?.version !== undefined && observedVersion !== undefined
    && observedVersion !== current.version && observedVersion !== current.observedVersion)
    || state?.resourcesDirty === true
  const reload = useCallback((): void => {
    if (!canRead) return
    if (mode === 'text-pages') reloadPages(tab.id, file, signal, observedVersion)
    else if (mode === 'bytes-complete') reloadAll(tab.id, file, signal, observedVersion)
    else rendererReload()
  }, [canRead, mode, reloadPages, reloadAll, rendererReload, tab.id, file, signal, observedVersion])
  useEffect(() => tab.actions.bindCommands({ refresh: reload }), [tab.actions, reload])
  useEffect(() => {
    if (state?.autoRefresh && changed && current !== undefined && !current.loading && meta.status === 'live') reload()
  }, [state?.autoRefresh, changed, current?.loading, meta.status, reload])
  const content = useMemo((): DocumentContent | undefined => {
    if (mode === 'renderer') {
      if (current === undefined) return undefined
      const revision = current.loadRevision
      return { kind: 'renderer', revision, reload: rendererReload,
        failed: () => { actions.rendererFailed(tab.id, revision) },
        loaded: (version) => { actions.rendered(tab.id, revision, version) } }
    }
    if (mode === 'bytes-complete') {
      return current?.complete === undefined ? undefined : {
        kind: 'bytes', data: current.complete.data,
      }
    }
    if (current === undefined || loaded.length === 0) return undefined
    return { kind: 'text', pages: loaded, text: loaded.filter(page => page.lines > 0).map(page => page.text).join('\n'), eof: current.eof }
  }, [mode, loaded, current?.complete, current?.eof, current?.loadRevision, rendererReload, actions, tab.id])

  // A known binary suffix with no matching renderer never reads: no plain-text
  // fallback, no viewer control, only the path, the unsupported line, and the
  // contributions that hand the file to the Host.
  if (selected === undefined && unviewable) {
    const { name: unsupportedName } = pathPartsOf(displayPath)
    return (
      <div className={css.preview} data-textpreview-state="unsupported" data-textpreview-url={tab.contentId}>
        <div className={css.header}>
          <PathLabel path={displayPath} className={css.path} data-textpreview-path />
          {fileOwner !== undefined && renderSlot('sidebar.right.tab.document.actions', fileOwner)}
        </div>
        <div className={css.body} data-textpreview-body>
          <div className={css.empty} data-textpreview-unsupported>
            <FileTypeIcon kind={classifyFileType(unsupportedName)} size={36} className={css.emptyIcon} />
            <p className={css.emptyLine}>{t('unsupportedFile')}</p>
            {fileOwner !== undefined && renderSlot('sidebar.right.tab.document.unpreviewable', fileOwner)}
          </div>
        </div>
      </div>
    )
  }
  if (state === undefined || selected === undefined) {
    return (
      <div className={css.status} data-textpreview-state="loading">
        {meta.status === 'none'
          ? <p className={css.statusLine}>{t('resourceUnavailable')}</p>
          : <LoadingIndicator label={t('loading')} />}
      </div>
    )
  }
  const next = loadedThrough + 1
  const { name } = pathPartsOf(displayPath)
  const loadNext = (): void => {
    if (!canRead || current?.loading || current?.eof) return
    loadPage(tab.id, file, next, signal, meta.value?.version)
  }
  return (
    <div className={css.preview} data-textpreview-state="text" data-textpreview-url={tab.contentId} data-document-preview={selected.id}>
      {meta.failure !== undefined && hasContent
        ? (
          // The file's metadata failed — gone, or its workspace unknown — which
          // outranks a pending change; the pages already read stay under it.
          // With nothing read the body's own failure already says it, so the
          // bar would only repeat the same line.
          <p className={css.changed} data-textpreview-meta-failed={meta.failure.code}>
            <span>{failureLine(t, meta.failure)}</span>
            <button
              type="button"
              className={css.action}
              data-textpreview-reload-now
              onClick={reload}
            >
              {t('reloadNow')}
            </button>
          </p>
        )
        : changed && (
          <p className={css.changed} data-textpreview-changed>
            <span>{t('changed')}</span>
            <button
              type="button"
              className={css.action}
              data-textpreview-reload-now
              onClick={reload}
            >
              {t('reloadNow')}
            </button>
          </p>
        )}
      <div className={css.header}>
        <PathLabel path={displayPath} className={css.path} data-textpreview-path />
        {markdownViews !== undefined && (
          <div className={css.viewSwitch} role="group" aria-label={t('markdownView')} data-markdown-view-switch>
            {(['rendered', 'source'] as const).map(view => (
              <button
                key={view}
                type="button"
                className={css.viewOption}
                aria-pressed={selected.id === markdownViews[view].id}
                data-markdown-view={view}
                onClick={() => { writeMarkdownView(view); setMarkdownView(view); actions.selected(tab.id, markdownViews[view].id) }}
              >
                {t(`markdownView.${view}`)}
              </button>
            ))}
          </div>
        )}
        {markdownViews === undefined && candidates.length > 1
          && (
            <Menu
              open={menuOpen}
              anchor={(
                <button type="button" className={clsx(css.tool, css.viewerTool)} aria-label={t('openWith')} title={selected.title()} data-document-viewer-menu onClick={() => { setMenuOpen(value => !value) }}>
                  {selected.title()}
                </button>
              )}
              items={candidates.map(candidate => ({ id: candidate.id, label: candidate.title() }))}
              selectedId={selected.id}
              onSelect={(id) => { actions.selected(tab.id, id); setMenuOpen(false) }}
              onClose={() => { setMenuOpen(false) }}
              align="end"
              portal
              dense
            />
          )}
        {selected.wrap === true && (
          // The tooltip names the action while the stable aria name and
          // `aria-pressed` expose the control and its current state.
          <Tooltip label={t(state.wrap ? 'wrap.disable' : 'wrap.enable')} side="bottom" delayMs={500}>
            <button
              type="button"
              className={css.tool}
              aria-pressed={state.wrap}
              aria-label={t('wrap.aria')}
              data-textpreview-tool="wrap"
              onClick={() => { actions.toggledWrap(tab.id) }}
            >
              {state.wrap ? <IconNowrapFillRegular /> : <IconWrapFillRegular />}
            </button>
          </Tooltip>
        )}
        {content !== undefined && renderSlot('sidebar.right.tab.document.action', { content }, { entryKey: selected.id, hookContext: useTabInfo })}
        <span hidden>
          <Tooltip label={t(state.autoRefresh ? 'autoRefresh.disable' : 'autoRefresh.enable')} side="bottom" delayMs={500}>
            <button type="button" className={css.tool} aria-label={t('autoRefresh')}
              aria-pressed={state.autoRefresh} data-textpreview-tool="auto-refresh"
              onClick={() => { actions.toggledAutoRefresh(tab.id) }}>
              {state.autoRefresh ? <IconPauseOutlineRegular /> : <IconPlayOutlineRegular />}
            </button>
          </Tooltip>
        </span>
        {/* Preview and file-tree refresh controls own different reload lifecycles and locale namespaces. */}
        {/* jscpd:ignore-start */}
        <Tooltip label={t('reload')} shortcutKeys={tab.refreshShortcut?.keys} side="bottom" delayMs={500}>
          <button
            type="button"
            className={css.tool}
            aria-label={t('reload')}
            data-textpreview-tool="reload"
            aria-keyshortcuts={tab.refreshShortcut?.aria}
            onClick={reload}
          >
            <IconRefreshOutlineRegular />
          </button>
        </Tooltip>
        {/* jscpd:ignore-end */}
        {fileOwner !== undefined && renderSlot('sidebar.right.tab.document.actions', fileOwner)}
      </div>
      <div
        ref={bindBody}
        className={clsx(css.body, state.wrap && css.wrap)}
        data-textpreview-body
        data-textpreview-wrap={state.wrap ? '' : undefined}
        onScrollCapture={(event) => {
          const body = scrollportRef.current
          /* v8 ignore next -- callback refs bind the scrollport during commit, before user input. */
          if (body === null) return
          if (event.target !== body) return
          actions.scrolled(tab.id, body.scrollTop)
          if (mode === 'text-pages' && current?.failure === undefined && body.clientHeight > 0
            && body.scrollTop + body.clientHeight >= body.scrollHeight - 1) loadNext()
        }}
      >
        {mode !== 'renderer' && !hasContent && current?.failure === undefined && (
          <LoadingIndicator label={t('loading')} />
        )}
        {content !== undefined && renderSlot('sidebar.right.tab.document', {
          resourceAddress: tab.contentId, content, wrap: state.wrap, scrollportRef: bindScrollport,
          addResource: add, setResources: set,
        }, {
          entryKey: selected.id, hookContext: useTabInfo,
          fallback: <p className={css.statusLine}>{t('rendererUnavailable', { name: selected.title() })}</p>,
        })}
        {current?.failure !== undefined && (hasContent
          ? (
            <p className={css.statusLine} data-textpreview-failed={current.failure.code}>
              <span>{failureLine(t, current.failure)}</span>
              <button
                type="button"
                className={css.action}
                data-textpreview-retry
                onClick={loadNext}
              >
                {t('retry')}
              </button>
            </p>
          )
          : (
            // With no content, the failure names its recourse: retry the
            // selected renderer's read when a second read may resolve it, hand
            // a file this preview cannot render to the unpreviewable
            // contributions, and offer nothing for a path with nothing to show.
            // Metadata observation remains owned by the resource provider.
            <div className={css.empty} data-textpreview-failed={current.failure.code}>
              <FileTypeIcon kind={classifyFileType(name)} size={36} className={css.emptyIcon} />
              <p className={css.emptyLine}>{failureLine(t, current.failure)}</p>
              {emptyFailureRecourse(current.failure) === 'open' && fileOwner !== undefined
                && renderSlot('sidebar.right.tab.document.unpreviewable', fileOwner)}
              {emptyFailureRecourse(current.failure) === 'retry' && (
                <button
                  type="button"
                  className={css.retry}
                  data-textpreview-retry
                  onClick={reload}
                >
                  <IconRefreshOutlineRegular size={14} />
                  {t('retry')}
                </button>
              )}
            </div>
          ))}
        {mode === 'text-pages' && current !== undefined && loaded.length > 0 && !current.eof && current.failure === undefined && (
          <button
            type="button"
            className={css.more}
            disabled={current.loading}
            data-textpreview-more
            onClick={loadNext}
          >
            {current.loading ? <LoadingIndicator inline label={t('loading')} /> : t('loadMore')}
          </button>
        )}
      </div>
    </div>
  )
}
