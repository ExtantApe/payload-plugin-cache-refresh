import type { Config, Endpoint, PayloadRequest } from 'payload'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const revalidateTag = vi.fn()
vi.mock('next/cache.js', () => ({ revalidateTag: (...a: unknown[]) => revalidateTag(...a) }))

import { cacheRefreshPlugin, type CacheRefreshOptions } from '../src/index.js'

type FakeUser = { id: string; collection: string; email: string; role?: string }
const admin: FakeUser = { id: 'u1', collection: 'users', email: 'admin@example.test', role: 'admin' }
const member: FakeUser = { id: 'u2', collection: 'users', email: 'member@example.test', role: 'member' }

const logger = { warn: vi.fn(), error: vi.fn() }
const sameSite = { 'content-type': 'application/json', origin: 'https://admin.example.test', 'sec-fetch-site': 'same-origin' }
const reqOf = (user: FakeUser | null, body?: unknown, headers: Record<string, string> = sameSite): PayloadRequest =>
  ({ user, url: 'https://admin.example.test/api/cache-refresh', headers: new Headers(headers), payload: { logger }, json: async () => body ?? {} }) as unknown as PayloadRequest

const base: CacheRefreshOptions = {
  cooldownMs: 0,
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
  vi.useRealTimers()
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

describe('same-site check (CSRF)', () => {
  const textPlain = { ...sameSite, 'content-type': 'text/plain' }
  const attempts: [string, Record<string, string>, number][] = [
    ['text/plain form post', textPlain, 415],
    ['no content type', { origin: sameSite.origin, 'sec-fetch-site': 'same-origin' }, 415],
    ['cross-site Sec-Fetch-Site', { ...sameSite, 'sec-fetch-site': 'cross-site' }, 403],
    ['same-site (sibling) Sec-Fetch-Site', { ...sameSite, 'sec-fetch-site': 'same-site' }, 403],
    ['other Origin', { 'content-type': 'application/json', origin: 'https://evil.example.test' }, 403],
    ['Origin null', { 'content-type': 'application/json', origin: 'null' }, 403],
    ['no Origin and no Sec-Fetch-Site', { 'content-type': 'application/json' }, 403],
  ]
  it.each(attempts)('refuses %s and refreshes nothing', async (_n, headers, status) => {
    const onRefresh = vi.fn()
    const out = await call(endpoints({ onRefresh }).post, reqOf(admin, confirmAll, headers))
    expect(out.status).toBe(status)
    expect(revalidateTag).not.toHaveBeenCalled()
    expect(onRefresh).not.toHaveBeenCalled()
  })
  it('accepts application/json with a charset, and Origin alone', async () => {
    const h = { 'content-type': 'application/json; charset=utf-8', origin: sameSite.origin }
    expect((await call(endpoints().post, reqOf(admin, confirmAll, h))).status).toBe(200)
  })
  it('accepts Sec-Fetch-Site same-origin alone', async () => {
    const h = { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' }
    expect((await call(endpoints().post, reqOf(admin, confirmAll, h))).status).toBe(200)
  })
  it('uses allowedOrigins when given', async () => {
    const h = { 'content-type': 'application/json', origin: 'https://other.example.test' }
    expect((await call(endpoints({ allowedOrigins: ['https://other.example.test'] }).post, reqOf(admin, confirmAll, h))).status).toBe(200)
    expect((await call(endpoints({ allowedOrigins: ['https://other.example.test'] }).post, reqOf(admin, confirmAll))).status).toBe(403)
  })
  it('uses the Payload serverURL when no allowedOrigins is given', async () => {
    const cfg = cacheRefreshPlugin(base)({ serverURL: 'https://cms.example.test' } as unknown as Config) as Config
    const post = cfg.endpoints!.find((e) => e.method === 'post')!.handler
    expect((await call(post, reqOf(admin, confirmAll))).status).toBe(403)
    const h = { 'content-type': 'application/json', origin: 'https://cms.example.test' }
    expect((await call(post, reqOf(admin, confirmAll, h))).status).toBe(200)
  })
  it('still answers 401 and 403 for sign-in and rules before the site check', async () => {
    expect((await call(endpoints().post, reqOf(null, confirmAll, textPlain))).status).toBe(401)
    expect((await call(endpoints().post, reqOf(member, confirmAll, textPlain))).status).toBe(403)
  })
})

describe('lock and cooldown', () => {
  it('refuses a second press while one is running, then lets the first finish', async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const { post } = endpoints({ tags: async () => { await gate; return ['a'] } })
    const first = call(post, reqOf(admin, confirmAll))
    const second = await call(post, reqOf(admin, confirmAll))
    expect(second.status).toBe(429)
    release()
    expect((await first).status).toBe(200)
    expect(revalidateTag).toHaveBeenCalledTimes(1)
  })
  it('refuses a repeat inside the cooldown and allows it after', async () => {
    vi.useFakeTimers()
    const { post } = endpoints({ cooldownMs: 5000 })
    expect((await call(post, reqOf(admin, confirmAll))).status).toBe(200)
    expect((await call(post, reqOf(admin, confirmAll))).status).toBe(429)
    vi.advanceTimersByTime(5001)
    expect((await call(post, reqOf(admin, confirmAll))).status).toBe(200)
  })
  it('releases the lock when the refresh fails', async () => {
    const { post } = endpoints({ tags: async () => { throw new Error('x') } })
    expect((await call(post, reqOf(admin, confirmAll))).status).toBe(500)
    expect((await call(post, reqOf(admin, confirmAll))).status).toBe(500)
  })
  it('does not count a refused or unconfirmed press toward the cooldown', async () => {
    const { post } = endpoints({ cooldownMs: 60000 })
    await call(post, reqOf(admin, {}))
    await call(post, reqOf(admin, confirmAll, { 'content-type': 'text/plain' }))
    expect((await call(post, reqOf(admin, confirmAll))).status).toBe(200)
  })
})

describe('warming', () => {
  const warmOpts = { warmBaseUrl: 'https://site.example.test', warmPaths: ['/', '/about', '/news'] }
  it('fetches each path once, in order, after the refresh', async () => {
    const seen: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (u: URL) => { seen.push(`${revalidateTag.mock.calls.length}:${u.pathname}`); return new Response('ok') }))
    const out = await call(endpoints(warmOpts).post, reqOf(admin, confirmAll))
    expect(seen).toEqual(['3:/', '3:/about', '3:/news'])
    expect(out.body.warmed).toEqual({ attempted: 3, ok: 3, failed: 0, timedOut: 0, skipped: 0, deadlineReached: false })
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
    expect(out).toMatchObject({ status: 200, body: { refreshed: true, warmed: { attempted: 3, ok: 0, failed: 2, timedOut: 1 } } })
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
    expect(out.body.warmed).toMatchObject({ attempted: 1, ok: 1, failed: 2 })
  })
  it('does not warm without a base address', async () => {
    const f = vi.fn()
    vi.stubGlobal('fetch', f)
    await call(endpoints({ warmPaths: ['/'] }).post, reqOf(admin, confirmAll))
    expect(f).not.toHaveBeenCalled()
  })
  it.each([['/\\evil.example.test'], ['//evil.example.test'], ['/\\\\evil.example.test'], ['/ok\\x'], ['\\\\evil.example.test'], ['/\t/evil.example.test'], ['evil.example.test'], ['']])('refuses the path %j without fetching', async (bad) => {
    const f = vi.fn(async () => new Response('ok'))
    vi.stubGlobal('fetch', f)
    const out = await call(endpoints({ ...warmOpts, warmPaths: [bad] }).post, reqOf(admin, confirmAll))
    expect(f).not.toHaveBeenCalled()
    expect(out.body.warmed).toMatchObject({ attempted: 0, failed: 1 })
  })
  it('only ever fetches URLs on the configured origin', async () => {
    const seen: URL[] = []
    vi.stubGlobal('fetch', vi.fn(async (u: URL) => { seen.push(u); return new Response('ok') }))
    await call(endpoints({ ...warmOpts, warmBaseUrl: 'https://site.example.test/some/base', warmPaths: ['/a?x=1', '/b#h', '/c/../d'] }).post, reqOf(admin, confirmAll))
    expect(seen).toHaveLength(3)
    for (const u of seen) expect(u.origin).toBe('https://site.example.test')
  })
  it('does not warm with an invalid base address', async () => {
    const f = vi.fn()
    vi.stubGlobal('fetch', f)
    const out = await call(endpoints({ warmBaseUrl: 'not a url', warmPaths: ['/'] }).post, reqOf(admin, confirmAll))
    expect(f).not.toHaveBeenCalled()
    expect(out.status).toBe(200)
  })
  it('stops at the deadline, skips the rest and says so', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { await new Promise((r) => setTimeout(r, 60)); return new Response('ok') }))
    const out = await call(endpoints({ ...warmOpts, warmDeadlineMs: 100, warmTimeoutMs: 1000, warmPaths: ['/1', '/2', '/3', '/4', '/5'] }).post, reqOf(admin, confirmAll))
    expect(out.status).toBe(200)
    expect(out.body).toMatchObject({ refreshed: true, count: 3 })
    expect(out.body.warmed.deadlineReached).toBe(true)
    expect(out.body.warmed.skipped).toBeGreaterThan(0)
    expect(out.body.warmed.ok + out.body.warmed.skipped + out.body.warmed.failed + out.body.warmed.timedOut).toBe(5)
  })
  it('caps each fetch at the time left and counts a timeout', async () => {
    vi.stubGlobal('fetch', vi.fn((_u: URL, init: RequestInit) => new Promise((_r, rej) => init.signal!.addEventListener('abort', () => rej(init.signal!.reason)))))
    const out = await call(endpoints({ ...warmOpts, warmDeadlineMs: 50, warmTimeoutMs: 5000, warmPaths: ['/1', '/2'] }).post, reqOf(admin, confirmAll))
    expect(out.body.warmed).toMatchObject({ attempted: 1, timedOut: 1, deadlineReached: true, skipped: 1 })
  })
  it('does not follow redirects off site', async () => {
    const f = vi.fn(async () => new Response('ok'))
    vi.stubGlobal('fetch', f)
    await call(endpoints({ ...warmOpts, warmPaths: ['/'] }).post, reqOf(admin, confirmAll))
    expect((f.mock.calls[0] as unknown as [URL, RequestInit])[1].redirect).toBe('manual')
  })
})
