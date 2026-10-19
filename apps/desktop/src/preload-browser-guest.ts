/**
 * Sidebar Browser guest preload. An embedded page has no window of its own, so it reports an outer
 * window of 0×0, which sign-in pages such as Google's read as an embedded browser. Before the page's own
 * scripts run, this reports the screen's available size instead, as a page in a full-size browser window
 * sees. (Harness Studio patch.)
 */
import { contextBridge } from 'electron'

contextBridge.executeInMainWorld({
  func: () => {
    const outer = { outerWidth: () => screen.availWidth, outerHeight: () => screen.availHeight }
    for (const [name, read] of Object.entries(outer)) {
      if (window[name as keyof typeof outer] !== 0) continue
      Object.defineProperty(window, name, { configurable: true, enumerable: true, get: read })
    }
  },
})
