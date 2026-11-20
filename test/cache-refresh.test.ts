import type { Config, Endpoint, PayloadRequest } from 'payload'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const revalidateTag = vi.fn()
vi.mock('next/cache', () => ({ revalidateTag: (...a: unknown[]) => revalidateTag(...a) }))

import { cacheRefreshPlugin, type CacheRefreshOptions } from '../src/index.js'

type FakeUser = { id: string; collection: string; email: string; role?: string }
const admin: FakeUser = { id: 'u1', collection: 'users', email: 'admin@example.test', role: 'admin' }
const member: FakeUser = { id: 'u2', collection: 'users', email: 'member@example.test', role: 'member' }

const logger = { warn: vi.fn(), error: vi.fn() }
const reqOf = (user: FakeUser | null, body?: unknown): PayloadRequest =>
  ({ user, payload: { logger }, json: async () => body ?? {} }) as unknown as PayloadRequest

const base: CacheRefreshOptions = {
  canRefresh: (req) => (req.user as FakeUser | null)?.role === 'admin',
  tags: ['posts', 'pages', 'menu'],
}

function endpoints(opts: Partial<CacheRefreshOptions> = {}) {
  const cfg = cacheRefreshPlugin({ ...base, ...opts })({ collections: [] } as unknown as Config) as Config
  const find = (method: string) => cfg.endpoints!.find((e: Endpoint) => e.method === method)!
  return { cfg, get: find('get').handler, post: find('post').handler }
}
const call = async (h: Endpoint['handler'], req: PayloadRequest) => {
  try {
    const res = await h(req)
    return { status: res.status, body: await res.json() }
  } catch (err) {
    return { status: (err as { status: number }).status, body: { error: (err as Error).message } }
  }
}
const confirmAll = { confirm: true, scope: 'all' }

beforeEach(() => {
  revalidateTag.mockReset()
  logger.warn.mockReset()
  logger.error.mockReset()
})
afterEach(() => vi.unstubAllGlobals())

describe('setup', () => {
  it('refuses to load without canRefresh or tags', () => {
    expect(() => cacheRefreshPlugin({ tags: ['a'] } as unknown as CacheRefreshOptions)({} as Config)).toThrow(/canRefresh/)
    expect(() => cacheRefreshPlugin({ canRefresh: () => true } as unknown as CacheRefreshOptions)({} as Config)).toThrow(/tags/)
  })
  it('adds the endpoints and the dashboard button, and keeps what was there', () => {
    const cfg = cacheRefreshPlugin(base)({ endpoints: [{ path: '/x', method: 'get', handler: async () => new Response() }], admin: { components: { beforeDashboard: ['a#B'] } } } as unknown as Config) as Config
    expect(cfg.endpoints).toHaveLength(3)
    expect(cfg.admin?.components?.beforeDashboard).toEqual(['a#B', '@extantape/payload-plugin-cache-refresh/client#CacheRefreshButton'])
  })
  it('leaves the dashboard alone with adminButton false', () => {
    const cfg = cacheRefreshPlugin({ ...base, adminButton: false })({} as Config) as Config
    expect(cfg.admin?.components).toBeUndefined()
  })
})

describe('access', () => {
  it('refuses a signed-out request with 401 and expires nothing', async () => {
    const { post, get } = endpoints()
    expect((await call(post, reqOf(null, confirmAll))).status).toBe(401)
    expect((await call(get, reqOf(null))).status).toBe(401)
    expect(revalidateTag).not.toHaveBeenCalled()
  })
  it('refuses a signed-in user the host does not allow with 403', async () => {
    const { post, get } = endpoints()
    expect((await call(post, reqOf(member, confirmAll))).status).toBe(403)
    expect((await call(get, reqOf(member))).status).toBe(403)
    expect(revalidateTag).not.toHaveBeenCalled()
  })
  it('fails closed when canRefresh throws or answers something other than true', async () => {
    expect((await call(endpoints({ canRefresh: () => { throw new Error('boom') } }).post, reqOf(admin, confirmAll))).status).toBe(403)
    expect((await call(endpoints({ canRefresh: (() => 'yes') as never }).post, reqOf(admin, confirmAll))).status).toBe(403)
    expect(revalidateTag).not.toHaveBeenCalled()
  })
  it('lets an allowed user read the status', async () => {
    const out = await call(endpoints().get, reqOf(admin))
    expect(out).toMatchObject({ status: 200, body: { allowed: true, mode: 'stale', hasChanged: false } })
  })
})

describe('confirmation', () => {
  it.each([[{}], [{ confirm: false }], [{ confirm: 'true' }], [{ scope: 'all' }]])('does nothing without confirm: true (%j)', async (body) => {
    const onRefresh = vi.fn()
    const { post } = endpoints({ onRefresh })
    const out = await call(post, reqOf(admin, body))
    expect(out.status).toBe(400)
    expect(revalidateTag).not.toHaveBeenCalled()
    expect(onRefresh).not.toHaveBeenCalled()
  })
  it('refreshes once confirmed', async () => {
    const out = await call(endpoints().post, reqOf(admin, confirmAll))
    expect(out).toMatchObject({ status: 200, body: { refreshed: true, count: 3 } })
    expect(revalidateTag).toHaveBeenCalledTimes(3)
  })
})

describe('the tag list', () => {
  it('accepts an async function and removes duplicates', async () => {
    const { post } = endpoints({ tags: async () => ['a', 'b', 'a'] })
    expect((await call(post, reqOf(admin, confirmAll))).body.count).toBe(2)
    expect(revalidateTag.mock.calls.map((c) => c[0])).toEqual(['a', 'b'])
  })
  it('refuses with 500 and expires nothing when the function throws', async () => {
    const onRefresh = vi.fn()
    const { post } = endpoints({ tags: async () => { throw new Error('db down') }, onRefresh })
    const out = await call(post, reqOf(admin, confirmAll))
    expect(out.status).toBe(500)
    expect(revalidateTag).not.toHaveBeenCalled()
    expect(onRefresh).not.toHaveBeenCalled()
  })
  it('refuses the whole list, with no partial expiry, when one tag is bad', async () => {
    for (const bad of [['ok', ''], ['ok', 42], ['ok', 'x'.repeat(257)]]) {
      const out = await call(endpoints({ tags: bad as string[] }).post, reqOf(admin, confirmAll))
      expect(out.status).toBe(500)
    }
    expect(revalidateTag).not.toHaveBeenCalled()
  })
})

describe('onRefresh', () => {
  it('receives who, when and how many', async () => {
    const onRefresh = vi.fn()
    const before = Date.now()
    await call(endpoints({ onRefresh }).post, reqOf(admin, confirmAll))
    expect(onRefresh).toHaveBeenCalledOnce()
    const r = onRefresh.mock.calls[0]![0]
    expect(r.who).toEqual({ id: 'u1', collection: 'users', email: 'admin@example.test' })
    expect(r.count).toBe(3)
    expect(r.tags).toEqual(['posts', 'pages', 'menu'])
    expect(Date.parse(r.at)).toBeGreaterThanOrEqual(before - 1000)
    expect(r).toMatchObject({ scope: 'all', mode: 'stale' })
  })
  it('failing keeps the refresh and says it was not recorded', async () => {
    const { post } = endpoints({ onRefresh: async () => { throw new Error('audit down') } })
    const out = await call(post, reqOf(admin, confirmAll))
    expect(out).toMatchObject({ status: 200, body: { refreshed: true, audited: false } })
    expect(logger.error).toHaveBeenCalled()
  })
})

describe('stale or expire', () => {
  it('defaults to stale-while-revalidate with the max profile, never expire 0', async () => {
    await call(endpoints().post, reqOf(admin, confirmAll))
    for (const c of revalidateTag.mock.calls) expect(c[1]).toBe('max')
  })
  it('takes a host profile in stale mode', async () => {
    await call(endpoints({ profile: { expire: 600 } }).post, reqOf(admin, confirmAll))
    for (const c of revalidateTag.mock.calls) expect(c[1]).toEqual({ expire: 600 })
  })
  it('expires at once when asked, whatever the profile', async () => {
    const out = await call(endpoints({ mode: 'expire', profile: 'max' }).post, reqOf(admin, confirmAll))
    expect(out.body.mode).toBe('expire')
    for (const c of revalidateTag.mock.calls) expect(c[1]).toEqual({ expire: 0 })
  })
})

describe('changed tags or everything', () => {
  const changedTags = async () => ['posts']
  it('refreshes only the changed tags by default', async () => {
    const out = await call(endpoints({ changedTags }).post, reqOf(admin, { confirm: true }))
    expect(out.body).toMatchObject({ count: 1, scope: 'changed' })
    expect(revalidateTag.mock.calls.map((c) => c[0])).toEqual(['posts'])
  })
  it('refreshes everything when the admin picks it', async () => {
    const out = await call(endpoints({ changedTags }).post, reqOf(admin, confirmAll))
    expect(out.body).toMatchObject({ count: 3, scope: 'all' })
  })
  it('does nothing, and records nothing, when nothing changed', async () => {
    const onRefresh = vi.fn()
    const out = await call(endpoints({ changedTags: async () => [], onRefresh }).post, reqOf(admin, { confirm: true }))
    expect(out.body).toMatchObject({ count: 0 })
    expect(revalidateTag).not.toHaveBeenCalled()
    expect(onRefresh).not.toHaveBeenCalled()
  })
  it('refuses, with no partial expiry, when changedTags throws', async () => {
    const out = await call(endpoints({ changedTags: async () => { throw new Error('x') } }).post, reqOf(admin, { confirm: true }))
    expect(out.status).toBe(500)
    expect(revalidateTag).not.toHaveBeenCalled()
  })
  it('reports the changed count to the button, or null if it cannot be read', async () => {
    expect((await call(endpoints({ changedTags }).get, reqOf(admin))).body).toMatchObject({ hasChanged: true, changedCount: 1 })
    expect((await call(endpoints({ changedTags: async () => { throw new Error('x') } }).get, reqOf(admin))).body).toMatchObject({ hasChanged: true, changedCount: null })
  })
  it('refreshes everything when no changedTags is given, whatever the body says', async () => {
    expect((await call(endpoints().post, reqOf(admin, { confirm: true, scope: 'changed' }))).body).toMatchObject({ count: 3, scope: 'all' })
  })
})

describe('warming', () => {
  const warmOpts = { warmBaseUrl: 'https://site.example.test', warmPaths: ['/', '/about', '/news'] }
  it('fetches each path once, in order, after the refresh', async () => {
    const seen: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (u: URL) => { seen.push(`${revalidateTag.mock.calls.length}:${u.pathname}`); return new Response('ok') }))
    const out = await call(endpoints(warmOpts).post, reqOf(admin, confirmAll))
    expect(seen).toEqual(['3:/', '3:/about', '3:/news'])
    expect(out.body.warmed).toEqual({ attempted: 3, failed: 0 })
  })
  it('never fails the refresh: errors, timeouts and bad statuses are counted', async () => {
    let n = 0
    vi.stubGlobal('fetch', vi.fn(async () => {
      n += 1
      if (n === 1) throw new Error('network')
      if (n === 2) throw new DOMException('timed out', 'TimeoutError')
      return new Response('no', { status: 500 })
    }))
    const onRefresh = vi.fn()
    const out = await call(endpoints({ ...warmOpts, onRefresh }).post, reqOf(admin, confirmAll))
    expect(out).toMatchObject({ status: 200, body: { refreshed: true, warmed: { attempted: 3, failed: 3 } } })
    expect(onRefresh).toHaveBeenCalledOnce()
  })
  it('gives each fetch a timeout signal', async () => {
    const f = vi.fn(async () => new Response('ok'))
    vi.stubGlobal('fetch', f)
    await call(endpoints({ ...warmOpts, warmPaths: ['/'], warmTimeoutMs: 250 }).post, reqOf(admin, confirmAll))
    expect((f.mock.calls[0] as unknown as [URL, RequestInit])[1].signal).toBeInstanceOf(AbortSignal)
  })
  it('survives a path function that throws', async () => {
    const f = vi.fn()
    vi.stubGlobal('fetch', f)
    const out = await call(endpoints({ ...warmOpts, warmPaths: async () => { throw new Error('x') } }).post, reqOf(admin, confirmAll))
    expect(out).toMatchObject({ status: 200, body: { refreshed: true, warmed: { attempted: 0 } } })
    expect(f).not.toHaveBeenCalled()
  })
  it('only fetches paths on the host base: absolute and protocol-relative addresses are skipped', async () => {
    const f = vi.fn(async () => new Response('ok'))
    vi.stubGlobal('fetch', f)
    const out = await call(endpoints({ ...warmOpts, warmPaths: ['https://evil.example.test/', '//evil.example.test/', '/ok'] }).post, reqOf(admin, confirmAll))
    expect(f).toHaveBeenCalledTimes(1)
    expect(out.body.warmed).toEqual({ attempted: 1, failed: 2 })
  })
  it('does not warm without a base address', async () => {
    const f = vi.fn()
    vi.stubGlobal('fetch', f)
    await call(endpoints({ warmPaths: ['/'] }).post, reqOf(admin, confirmAll))
    expect(f).not.toHaveBeenCalled()
  })
})
