/** Complete video and audio bytes played with the browser's own controls. */
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { pathPartsOf } from '@deepseek-ai/dsh-util-workspace-path'
import type { DocumentPreviewProps } from '../document/contract.ts'
import { LoadingIndicator } from '../LoadingIndicator.tsx'
import { hostFileOf } from '../rpc.ts'
import type {} from './locales.ts'
import css from './VideoBody.module.css'

/**
 * Media types assigned to the Blob by suffix. QuickTime files are given the MP4 type because Chromium plays the
 * H.264 or HEVC streams inside them through its MP4 demuxer but refuses `video/quicktime`.
 */
const VIDEO_MEDIA_TYPES = {
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  mov: 'video/mp4',
  webm: 'video/webm',
} as const

/** Audio media types by suffix; Opus files are Ogg containers. */
const AUDIO_MEDIA_TYPES = {
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  opus: 'audio/ogg',
  flac: 'audio/flac',
} as const

type VideoMediaType = typeof VIDEO_MEDIA_TYPES[keyof typeof VIDEO_MEDIA_TYPES] | typeof AUDIO_MEDIA_TYPES[keyof typeof AUDIO_MEDIA_TYPES]

/** Standard document props plus the video and audio renderers' dictionary. */
export type VideoBodyProps = DocumentPreviewProps & PropsLocale<'sidebarVideo'>

type VideoSource =
  | { readonly kind: 'ready'; readonly data: Uint8Array<ArrayBuffer>; readonly url: string }
  | { readonly kind: 'failed'; readonly data: Uint8Array<ArrayBuffer> }

/**
 * Resolve a supported filename to the media type assigned to its Blob.
 * @param path - decoded workspace file path.
 * @returns the video or audio media type, or undefined for an unregistered suffix.
 */
export function videoMediaType(path: string): VideoMediaType | undefined {
  const normalized = path.replaceAll('\\', '/')
  const name = normalized.slice(normalized.lastIndexOf('/') + 1).toLowerCase()
  const extension = name.slice(name.lastIndexOf('.') + 1)
  return VIDEO_MEDIA_TYPES[extension as keyof typeof VIDEO_MEDIA_TYPES] ?? AUDIO_MEDIA_TYPES[extension as keyof typeof AUDIO_MEDIA_TYPES]
}

/**
 * Play complete video or audio bytes in the pane, fitted to its width, with the browser's controls; video loops.
 * @param props - document bytes, resource identity, and locale.
 * @returns the player, or a status line while loading or after a decode failure.
 */
export function VideoBody(props: VideoBodyProps): ReactNode {
  const { content, resourceAddress, t } = props
  const path = useMemo(() => hostFileOf(resourceAddress).path, [resourceAddress])
  const mediaType = videoMediaType(path)
  const data = content.kind === 'bytes' ? content.data : undefined
  const [source, setSource] = useState<VideoSource>()
  const [playable, setPlayable] = useState(true)

  useEffect(() => {
    if (data === undefined || mediaType === undefined) return
    let url: string | undefined
    try {
      url = URL.createObjectURL(new Blob([data], { type: mediaType }))
      setSource({ kind: 'ready', data, url })
    } catch {
      setSource({ kind: 'failed', data })
    }
    setPlayable(true)
    return () => {
      if (url !== undefined) URL.revokeObjectURL(url)
    }
  }, [data, mediaType])

  if (data === undefined || mediaType === undefined) {
    return <p className={css.status} role="alert">{t('unsupported')}</p>
  }
  if (source?.data !== data) return <LoadingIndicator label={t('loading')} />
  const audio = mediaType.startsWith('audio/')
  if (source.kind === 'failed' || !playable) return <p className={css.status} role="alert">{t(audio ? 'audioFailed' : 'failed')}</p>
  const { name } = pathPartsOf(path)
  return (
    <div className={css.frame} data-video-preview data-media-preview={audio ? 'audio' : 'video'}>
      {audio
        ? <audio key={source.url} className={css.audio} src={source.url} controls preload="metadata"
          aria-label={t('audioPreview', { name })} onError={() => { setPlayable(false) }} />
        : <video key={source.url} className={css.video} src={source.url} controls loop playsInline preload="metadata"
          aria-label={t('preview', { name })} onError={() => { setPlayable(false) }} />}
    </div>
  )
}
