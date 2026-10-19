/** Read-only spreadsheet surface backed by browser-parsed workbook data. */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Workbook } from '@fortune-sheet/react'
import { Button, IconWarningTriangleOutlineRegular, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import fortuneCss from '@fortune-sheet/react/dist/index.css?inline'
import type { Cell } from '@fortune-sheet/core'
import type { ExcelFormat } from './format.ts'
import type { ExcelPreview } from './model.ts'
import type { LoadedExcelBodyProps } from './LazyExcelBody.tsx'
import { parseExcel } from './parse.ts'
import css from './ExcelBody.module.css'

type State = { data: Uint8Array<ArrayBuffer>; format: ExcelFormat } & ({ value: ExcelPreview } | { error: string })

/**
 * Font for cells that name none. FortuneSheet would draw them in Times New Roman; spreadsheet applications show
 * their sans-serif default, and plain cells usually inherit it without naming it.
 */
const DEFAULT_CELL_FONT = 'system-ui'

/** One rich-text run of a cell. */
type InlineRun = NonNullable<NonNullable<Cell['ct']>['s']>[number]

/**
 * Prepare cells for display: every cell is centred horizontally and vertically, whatever alignment the workbook
 * stores, and every cell and rich-text run without a font name gets the default sans-serif font.
 * @param preview - parsed workbook.
 * @returns the same workbook with alignment and font names set.
 */
function withDefaultFont(preview: ExcelPreview): ExcelPreview {
  return {
    ...preview,
    sheets: preview.sheets.map(sheet => (sheet.celldata === undefined ? sheet : {
      ...sheet,
      celldata: sheet.celldata.map((item) => {
        const v = item.v
        if (v === null || v === undefined) return item
        const runs = v.ct?.s?.map((run: InlineRun) => (run.ff === undefined ? { ...run, ff: DEFAULT_CELL_FONT } : run))
        return {
          ...item,
          v: { ...v, ht: 0, vt: 0, ...(v.ff === undefined ? { ff: DEFAULT_CELL_FONT } : {}), ...(runs === undefined || v.ct === undefined ? {} : { ct: { ...v.ct, s: runs } }) },
        }
      }),
    })),
  }
}
const scopedStyles = `@scope ([data-excel-preview]) { ${fortuneCss} }`

/**
 * Display stored spreadsheet values and formats without editing or recalculation.
 * Keep the mounted workbook sized to its preview pane.
 * @param props - Complete workbook bytes, limits, and locale.
 * @returns An isolated spreadsheet surface with cancellable loading.
 */
export function ExcelBody({ content, format, limits, t, loading }: LoadedExcelBodyProps): ReactNode {
  const data = content.kind === 'bytes' ? content.data : undefined
  const [state, setState] = useState<State>()
  const [attempt, setAttempt] = useState(0)
  const workbookRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (data === undefined) return
    const controller = new AbortController()
    setState(undefined)
    void parseExcel(data, format, limits, controller.signal).then(
      (value) => { if (!controller.signal.aborted) setState({ data, format, value: withDefaultFont(value) }) },
      (error: unknown) => { if (!controller.signal.aborted) setState({ data, format, error: error instanceof Error ? error.message : 'invalid' }) },
    )
    return () => { controller.abort() }
  }, [data, format, limits, attempt])
  useEffect(() => {
    const element = workbookRef.current
    if (element === null || typeof ResizeObserver === 'undefined') return
    // FortuneSheet measures its canvas on window resize, but pane resizing does not emit that event.
    const observer = new ResizeObserver(() => { window.dispatchEvent(new Event('resize')) })
    observer.observe(element)
    return () => { observer.disconnect() }
  }, [state])
  if (data === undefined) return <p className={css.status} role="alert">{t('invalid')}</p>
  if (state?.data !== data || state.format !== format) return loading
  if ('error' in state) return <div className={css.status} role="alert">
    <span>{t(state.error === 'tooLarge' || state.error === 'timeout' || state.error === 'encoding' ? state.error : 'invalid')}</span>
    <Button size="sm" onClick={() => { setAttempt(value => value + 1) }}>{t('retry')}</Button>
  </div>
  const hasFormulas = state.value.sheets.some(sheet => sheet.celldata?.some(cell => cell.v?.f !== undefined))
  return <section className={css.body} data-excel-preview aria-label={t('title')}>
    <style>{scopedStyles}</style>
    {state.value.unsupportedFeatures.length > 0 && <div className={css.notice} role="note" data-excel-unsupported-notice>
      <IconWarningTriangleOutlineRegular size={16} />
      <span>{t('unsupportedNotice', { features: state.value.unsupportedFeatures.map(feature => t(feature)).join(t('featureSeparator')) })}</span>
    </div>}
    <div ref={workbookRef} className={`${css.workbook} ${hasFormulas ? css.withFormulaWarning : ''}`}>
      {hasFormulas && <Tooltip portal label={t('formulaWarning')} side="bottom" delayMs={500}>
        <button type="button" className={css.formulaWarning} aria-label={t('formulaWarning')} data-excel-formula-warning>
          <IconWarningTriangleOutlineRegular size={14} />
        </button>
      </Tooltip>}
      <Workbook key={`${attempt}:${t('language')}`} data={state.value.sheets} lang={t('language')}
        allowEdit={false} showToolbar={false} showFormulaBar showSheetTabs forceCalculation={false}
        cellContextMenu={['copy']} headerContextMenu={[]} sheetTabContextMenu={[]} filterContextMenu={[]} />
    </div>
  </section>
}
