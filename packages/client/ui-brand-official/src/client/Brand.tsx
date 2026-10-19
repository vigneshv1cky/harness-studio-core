import { BrandWordmark, HarnessStudioMark } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SidebarBrandMarkOwnerProps } from '@deepseek-ai/dsh-client-ui-sidebar/client'

/**
 * Render Harness Studio's mark with the presentation requested by its host surface.
 * @param props - Host-supplied mark presentation.
 * @returns the target mark on its blue tile, the same artwork as the app and extension icons.
 */
export function OfficialBrandMark({ size }: SidebarBrandMarkOwnerProps) {
  return <HarnessStudioMark size={size} />
}

/**
 * Render the official name artwork without its independently slotted mark.
 * @returns the official name wordmark.
 */
export function OfficialBrandName() {
  return <BrandWordmark includeMark={false} />
}
