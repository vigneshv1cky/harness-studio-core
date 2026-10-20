// @vitest-environment jsdom
/** Video Blob ownership, media types, player rendering, failure states, and registration. */
import { Context } from '@deepseek-ai/cordis'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { TabId } from '@deepseek-ai/dsh-client-ui-dockkit'
import { DocumentPreviewRegistry } from '../src/client/document/registry.ts'
import { VideoBody, videoMediaType, type VideoBodyProps } from '../src/client/video/VideoBody.tsx'
import { apply, VIDEO_BODY_ID, VIDEO_EXTENSIONS, videoBodyDefinition } from '../src/client/video/index.ts'
import { en, zh } from '../src/client/video/locales.ts'

const translations: ReadonlyMap<string, string> = new Map(Object.entries(en))
let createDescriptor: PropertyDescriptor | undefined
let revokeDescriptor: PropertyDescriptor | undefined
const create = vi.fn<(blob: Blob) => string>()
const revoke = vi.fn<(url: string) => void>()

beforeEach(() => {
  createDescriptor = Object.getOwnPropertyDescriptor(URL, 'createObjectURL')
  revokeDescriptor = Object.getOwnPropertyDescriptor(URL, 'revokeObjectURL')
  create.mockReset().mockImplementation(() => `blob:https://preview.invalid/${create.mock.calls.length}`)
  revoke.mockReset()
  Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: create })
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: revoke })
})

afterEach(() => {
  try { cleanup() } finally {
    if (createDescriptor === undefined) Reflect.deleteProperty(URL, 'createObjectURL')
    else Object.defineProperty(URL, 'createObjectURL', createDescriptor)
    if (revokeDescriptor === undefined) Reflect.deleteProperty(URL, 'revokeObjectURL')
    else Object.defineProperty(URL, 'revokeObjectURL', revokeDescriptor)
    vi.restoreAllMocks()
  }
})

function props(path = 'out/clip.mp4', content: VideoBodyProps['content'] = { kind: 'bytes', data: new Uint8Array([1, 2, 3]) }): VideoBodyProps {
  return {
    resourceAddress: `dsh-resource://file/session/video/${path}`,
    content,
    wrap: false,
    sessionId: 'video' as SessionId,
    useTabInfo: () => ({ tab: { id: 'video-tab' as TabId, signal: new AbortController().signal } }),
    useResource: () => ({ value: undefined }),
    t: (key, params) => {
      const value = translations.get(key) ?? key
      return params === undefined ? value : Object.entries(params)
        .reduce((text, [name, replacement]) => text.replace(`{${name}}`, String(replacement)), value)
    },
  } as VideoBodyProps
}

describe('VideoBody', () => {
  it.each([
    ['clip.mp4', 'video/mp4'],
    ['CLIP.M4V', 'video/mp4'],
    ['screen.mov', 'video/mp4'],
    ['loop.webm', 'video/webm'],
    ['notes.txt', undefined],
  ])('maps %s to %s', (path, type) => {
    expect(videoMediaType(path)).toBe(type)
  })

  it('plays the bytes through a Blob URL with controls and looping, and revokes it on unmount', () => {
    const view = render(<VideoBody {...props()} />)
    const video = screen.getByLabelText('Video preview: clip.mp4')
    expect(video.tagName).toBe('VIDEO')
    expect(video.getAttribute('src')).toBe('blob:https://preview.invalid/1')
    expect(video.hasAttribute('controls')).toBe(true)
    expect(video.hasAttribute('loop')).toBe(true)
    expect(create.mock.calls[0]?.[0].type).toBe('video/mp4')
    view.unmount()
    expect(revoke).toHaveBeenCalledWith('blob:https://preview.invalid/1')
  })

  it('says the video cannot be played when the browser cannot decode it', () => {
    render(<VideoBody {...props()} />)
    fireEvent.error(screen.getByLabelText('Video preview: clip.mp4'))
    expect(screen.getByRole('alert').textContent).toBe(en.failed)
  })

  it('asks for the complete file when the content is not bytes', () => {
    render(<VideoBody {...props('clip.mp4', { kind: 'text-pages' } as never)} />)
    expect(screen.getByRole('alert').textContent).toBe(en.unsupported)
    expect(create).not.toHaveBeenCalled()
  })
})

describe('video registration', () => {
  it('claims common video suffixes as a builtin complete-byte renderer', () => {
    const title = vi.fn(() => 'localized video')
    expect(videoBodyDefinition(title)).toMatchObject({
      id: VIDEO_BODY_ID, extensions: VIDEO_EXTENSIONS, binaryExtensions: VIDEO_EXTENSIONS,
      priority: 'builtin', loading: 'bytes-complete', wrap: false,
    })
    expect(Object.keys(zh)).toEqual(Object.keys(en))
  })

  it('registers its dictionary, metadata and keyed body, then removes them', async () => {
    const ctx = new Context()
    const registry = new DocumentPreviewRegistry()
    const dictionaries = new Map<string, unknown>()
    const bodies = new Map<string, unknown>()
    const register = vi.fn((options: { key: string }, body: unknown) => {
      bodies.set(options.key, body)
      return () => { bodies.delete(options.key) }
    })
    ctx.provide('documentPreviews', registry)
    ctx.provide('slots', { inject: (_key: string, callback: () => () => void) => callback(), register } as never)
    ctx.provide('locale', {
      bind: () => (key: keyof typeof en) => en[key],
      register: (name: string, value: unknown) => {
        dictionaries.set(name, value)
        return () => { dictionaries.delete(name) }
      },
    } as never)
    const fiber = ctx.plugin({ apply })
    await fiber
    expect(dictionaries.get('sidebarVideo')).toEqual({ zh, en })
    expect(bodies.get(VIDEO_BODY_ID)).toBe(VideoBody)
    await fiber.dispose()
    expect(dictionaries.size).toBe(0)
    expect(bodies.size).toBe(0)
  })
})
