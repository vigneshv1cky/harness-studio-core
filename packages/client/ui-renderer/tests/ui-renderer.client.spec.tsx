// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup } from '@testing-library/react'
import { Context } from '@deepseek-ai/cordis'
import { SlotRegistry } from '../src/client/registry.ts'
import type { SlotScopeAdapter, StandardSourceBinding } from '../src/client/index.ts'
import { apply as nodeApply } from '@deepseek-ai/dsh-client-ui-renderer'
import * as UiRenderer from '../src/client/index.ts'

const mounted: (() => void)[] = []

afterEach(() => {
  act(() => { for (const unmount of mounted.splice(0)) unmount() })
  vi.restoreAllMocks()
  cleanup()
  document.body.innerHTML = ''
})

const stabilize = async (fn: () => void | Promise<void>): Promise<void> => {
  await act(async () => { await fn() })
}

async function bench() {
  const ctx = new Context()
  const fiber = ctx.plugin({ inject: [...UiRenderer.inject], apply: UiRenderer.apply })
  await fiber.await()
  const slots = ctx.get('slots') as SlotRegistry
  const absentBinding: StandardSourceBinding = {
    key: undefined,
    hooks: {},
    keyedHooks: {},
    props: {},
  }
  const current = {
    getSnapshot: () => absentBinding,
    subscribe: () => () => {},
  }
  const adapter: SlotScopeAdapter = {
    current,
    bindingSource: () => current,
  }
  slots.installScope('session', adapter)
  return { ctx, slots, fiber }
}

function container(): HTMLElement {
  const el = document.createElement('div')
  document.body.append(el)
  return el
}

describe('UI renderer plugin', () => {
  it('provides no host-side behavior', () => {
    expect(() => { nodeApply() }).not.toThrow()
  })

  it('installs the renderer and mounts the assembled application', async () => {
    const { ctx, slots } = await bench()
    slots.register({ name: 'root' }, () => <div data-testid="root-probe" />)
    const renderer = ctx.get('uiRenderer')
    expect(renderer).toBeDefined()
    const el = container()
    act(() => { mounted.push(renderer!.mount(el)) })
    expect(el.querySelector('[data-testid="root-probe"]')).toBeTruthy()
  })

  it('hydrates the boot page before switching to the assembled application', async () => {
    const { ctx, slots } = await bench()
    slots.register({ name: 'root' }, () => <div data-testid="root-probe" />)
    const el = container()
    el.innerHTML = '<div class="boot" data-dsh-boot=""><div><div class="spinner" data-dsh-boot-spinner="" style="--dsh-boot-arc: 180deg"></div><div>Loading plugins…</div></div></div>'
    const boot = el.firstElementChild
    const observer = new MutationObserver(() => {})
    observer.observe(el, { childList: true, subtree: true })
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})

    act(() => { mounted.push(ctx.get('uiRenderer')!.mount(el)) })

    const records = observer.takeRecords()
    observer.disconnect()
    expect(error).not.toHaveBeenCalled()
    error.mockRestore()
    expect(el.querySelector('[data-testid="root-probe"]')).toBeTruthy()
    expect(records.some(record => record.target === boot)).toBe(false)
  })

  it('returns an unmount disposer', async () => {
    const { ctx, slots } = await bench()
    slots.register({ name: 'root' }, () => <div data-testid="root-probe" />)
    const el = container()
    let unmount: () => void = () => {}
    act(() => { unmount = ctx.get('uiRenderer')!.mount(el) })
    act(() => { unmount() })
    expect(el.querySelector('[data-testid="root-probe"]')).toBeNull()
  })

  it('waits for the root entry and scope adapter when remounted into the same container', async () => {
    const first = await bench()
    const disposeRoot = first.slots.register({ name: 'root' }, () => <div data-testid="root-probe" />)
    const el = container()
    let unmount: () => void = () => {}
    act(() => { unmount = first.ctx.get('uiRenderer')!.mount(el) })
    act(() => { unmount() })
    disposeRoot()
    await stabilize(() => first.fiber.dispose())

    const ctx = new Context()
    const fiber = ctx.plugin({ inject: [...UiRenderer.inject], apply: UiRenderer.apply })
    await fiber.await()
    const slots = ctx.get('slots') as SlotRegistry
    act(() => { mounted.push(ctx.get('uiRenderer')!.mount(el)) })
    expect(el.textContent).toBe('')

    const absent: StandardSourceBinding = { key: undefined, hooks: {}, keyedHooks: {}, props: {} }
    const current = { getSnapshot: () => absent, subscribe: () => () => {} }
    await stabilize(() => { slots.installScope('session', { current, bindingSource: () => current }) })
    await stabilize(() => { slots.register({ name: 'root' }, () => <div data-testid="root-probe" />) })
    expect(el.querySelector('[data-testid="root-probe"]')).toBeTruthy()
  })

  it('reports a missing root entry on a first mount', async () => {
    const { ctx } = await bench()
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(() => { act(() => { mounted.push(ctx.get('uiRenderer')!.mount(container())) }) }).toThrow(/'root' has no registration/)
    error.mockRestore()
  })

  it('retracts the service and renderer with its fiber', async () => {
    const { ctx, slots, fiber } = await bench()
    await stabilize(() => fiber.dispose())
    expect(ctx.get('uiRenderer')).toBeUndefined()
    expect(() => slots.renderSlot('root', {})).toThrow('not installed')
  })
})
