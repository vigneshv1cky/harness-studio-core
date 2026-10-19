/**
 * Harness Studio: the Appearance and Permissions pages, each one column of preference rows like General, filled
 * from its own row list by the plugins that own the preferences.
 */
import type { PropsRenderSlots, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import css from './GeneralSection.module.css'

/**
 * The Appearance page: language, light or dark, colours and fonts.
 * @param props - composed slot props.
 * @returns the page's row column.
 */
export function AppearanceSection({ renderSlot }: PropsRuntime<'settings.section'> & PropsRenderSlots<'settings.appearance.item'>) {
  return <div className={css.section}>{renderSlot('settings.appearance.item', {})}</div>
}

/**
 * The Permissions page: the permission mode and what the agent's commands may reach.
 * @param props - composed slot props.
 * @returns the page's row column.
 */
export function PermissionsSection({ renderSlot }: PropsRuntime<'settings.section'> & PropsRenderSlots<'settings.permissions.item'>) {
  return <div className={css.section}>{renderSlot('settings.permissions.item', {})}</div>
}
