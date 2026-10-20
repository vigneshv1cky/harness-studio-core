/** Builtin video metadata and keyed document-body registration. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '../index.ts'
import type { DocumentPreviewDefinition } from '../document/registry.ts'
import { VideoBody } from './VideoBody.tsx'
import { en, zh } from './locales.ts'

/** Video implementation identity, shared by metadata and the keyed slot. */
export const VIDEO_BODY_ID = '@deepseek-ai/dsh-client-ui-sidebar-documentpreview/video'

/** File suffixes played by the builtin video body; their bytes are never readable text. */
export const VIDEO_EXTENSIONS = ['mp4', 'm4v', 'mov', 'webm'] as const

/**
 * Describe the builtin video renderer independently from its keyed body slot.
 * @param title - locale-owned implementation name.
 * @returns metadata for complete video files.
 */
export function videoBodyDefinition(title: () => string): DocumentPreviewDefinition {
  return {
    id: VIDEO_BODY_ID,
    extensions: VIDEO_EXTENSIONS,
    binaryExtensions: VIDEO_EXTENSIONS,
    priority: 'builtin',
    title,
    loading: 'bytes-complete',
    wrap: false,
  }
}

/**
 * Register the video dictionary, metadata, and body with reversible effects.
 * @param ctx - owning plugin context.
 */
export function apply(ctx: Context): void {
  const t = ctx.locale.bind('sidebarVideo')
  ctx.effect(() => ctx.locale.register('sidebarVideo', { zh, en }), 'document-video: dictionaries')
  ctx.effect(() => ctx.documentPreviews.register(videoBodyDefinition(() => t('title'))), 'document-video: metadata')
  ctx.effect(() => ctx.slots.inject('sidebar.right.tab.document', () => ctx.slots.register({
    name: 'sidebar.right.tab.document', key: VIDEO_BODY_ID, locale: 'sidebarVideo',
  }, VideoBody)), 'document-video: body')
}
