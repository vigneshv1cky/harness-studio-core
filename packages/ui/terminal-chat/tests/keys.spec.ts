/** Splitting terminal input into key presses. */

import { describe, expect, it } from 'vitest'
import { splitKeys } from '../src/keys.ts'

describe('terminal key splitting', () => {
  it('splits keys that arrive together into one press each', () => {
    expect(splitKeys('\u001b[B\u001b[B\u001bOA')).toEqual([['', { downArrow: true }], ['', { downArrow: true }], ['', { upArrow: true }]])
    expect(splitKeys('ab\u001b[B\r\u007f\b\t\u001b\u0003\u0004\u0001x')).toEqual([
      ['ab', {}], ['', { downArrow: true }], ['', { return: true }], ['', { backspace: true }], ['', { backspace: true }],
      ['', { tab: true }], ['', { escape: true }], ['c', { ctrl: true }], ['d', { ctrl: true }], ['x', {}],
    ])
  })

  it('keeps typed or pasted text whole, Enter alone as Enter, and drops sequences the chat does not use', () => {
    expect(splitKeys('\r')).toEqual([['', { return: true }]])
    expect(splitKeys('\n')).toEqual([['', { return: true }]])
    expect(splitKeys('hello\r')).toEqual([['hello\r', {}]])
    expect(splitKeys('one\r\ntwo')).toEqual([['one\r\ntwo', {}]])
    expect(splitKeys('a')).toEqual([['a', {}]])
    expect(splitKeys('\r\n')).toEqual([['', { return: true }], ['', { return: true }]])
    expect(splitKeys('\u001b[3~\u001b[C\u001b[Z')).toEqual([['', { delete: true }]])
  })
})
