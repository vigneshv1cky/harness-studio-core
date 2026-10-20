/** Locale-owned video and audio renderer labels and status text. */
export const zh = {
  title: '视频',
  preview: '视频预览：{name}',
  loading: '视频加载中...',
  failed: '无法播放这个视频，可能使用了此处不支持的编码',
  unsupported: '视频预览需要完整文件内容',
  audioTitle: '音频',
  audioPreview: '音频预览：{name}',
  audioFailed: '无法播放这个音频，可能使用了此处不支持的编码',
} satisfies Record<string, string>

/** Video renderer dictionary keys. */
export type VideoPreviewKey = keyof typeof zh

/** English dictionary with the same keys as the Chinese dictionary. */
export const en = {
  title: 'Video',
  preview: 'Video preview: {name}',
  loading: 'Loading video...',
  failed: 'This video could not be played here; it may use an unsupported codec.',
  unsupported: 'Video preview requires the complete file contents.',
  audioTitle: 'Audio',
  audioPreview: 'Audio preview: {name}',
  audioFailed: 'This audio could not be played here; it may use an unsupported codec.',
} satisfies Record<VideoPreviewKey, string>

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Video and audio preview selection, accessible names, and status text. */
    sidebarVideo: VideoPreviewKey
  }
}
