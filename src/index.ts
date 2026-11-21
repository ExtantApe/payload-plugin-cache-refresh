import { APIError, type Config, type Endpoint, type PayloadRequest, type Plugin } from 'payload'

import type { CacheRefreshOptions, RefreshMode, RefreshWho, Scope, TagProfile, WarmResult } from './types.js'

export type * from './types.js'

/**
 * Cache refresh for Payload: an endpoint and a dashboard button that refresh a Next.js site's cache tags for
 * the people the host allows. Knows nothing about any app's tag names, routes or roles.
 */

export const MAX_TAG_LENGTH = 256
const DEFAULT_PATH = '/cache-refresh'
const BUTTON = '@extantape/payload-plugin-cache-refresh/client#CacheRefreshButton'

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } })

const refuse = (message: string, status: number, reason: string): never => {
  throw new APIError(message, status, { reason }, true)
}

/** Sign-in first (401), then the host's rule (403). A rule that throws is a no. */
async function guard(req: PayloadRequest, opts: CacheRefreshOptions): Promise<RefreshWho> {
  const user = req.user as ({ id: string | number; collection?: string; email?: string } & Record<string, unknown>) | null
  if (!user) return refuse('Sign in first.', 401, 'signIn')
  let allowed = false
  try {
    allowed = (await opts.canRefresh(req)) === true
  } catch {
    allowed = false
  }
  if (!allowed) return refuse('You are not allowed to refresh the site cache.', 403, 'forbidden')
  return { id: user.id, collection: user.collection, ...(typeof user.email === 'string' ? { email: user.email } : {}) }
}

/** Checks a list from the host before anything is expired, so a bad list refuses the whole refresh. */
function cleanTags(list: unknown): string[] {
  if (!Array.isArray(list)) throw new Error('The tag list is not a list.')
  const out = new Set<string>()
  for (const t of list) {
    if (typeof t !== 'string' || t.length === 0) throw new Error('A tag is empty or not text.')
    if (t.length > MAX_TAG_LENGTH) throw new Error(`A tag is longer than ${MAX_TAG_LENGTH} characters, so Next.js would ignore it.`)
    out.add(t)
  }
  return [...out]
}

async function resolveTags(req: PayloadRequest, opts: CacheRefreshOptions, scope: Scope): Promise<string[]> {
  if (scope === 'changed' && opts.changedTags) return cleanTags(await opts.changedTags({ req }))
  return cleanTags(typeof opts.tags === 'function' ? await opts.tags({ req }) : opts.tags)
}

async function readBody(req: PayloadRequest): Promise<Record<string, unknown>> {
  try {
    const body = typeof req.json === 'function' ? await req.json() : req.data
    return body && typeof body === 'object' ? (body as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

/** The path rule: one leading slash, no backslash, no control characters. Anything else could leave the site. */
export const isSafePath = (path: unknown): path is string =>
  typeof path === 'string' && /^\/(?![/\\])/.test(path) && !path.includes('\\') && !/[\u0000-\u001f\u007f]/.test(path)

/** Fetches each path once, in order, inside one overall deadline. Never throws. */
async function warm(req: PayloadRequest, opts: CacheRefreshOptions, tags: string[], scope: Scope): Promise<WarmResult> {
  const result: WarmResult = { attempted: 0, ok: 0, failed: 0, timedOut: 0, skipped: 0, deadlineReached: false }
  if (!opts.warmPaths || !opts.warmBaseUrl) return result
  let origin: string
  try {
    origin = new URL(opts.warmBaseUrl).origin
  } catch {
    req.payload?.logger?.warn?.('cache-refresh: warmBaseUrl is not a valid address, so nothing was warmed.')
    return result
  }
  let paths: string[]
  try {
    paths = typeof opts.warmPaths === 'function' ? await opts.warmPaths({ req, tags, scope }) : opts.warmPaths
  } catch (err) {
    req.payload?.logger?.warn?.(`cache-refresh: the warm path list failed: ${(err as Error).message}`)
    return result
  }
  const each = opts.warmTimeoutMs ?? 5000
  const end = Date.now() + (opts.warmDeadlineMs ?? 15000)
  const list = Array.isArray(paths) ? paths : []
  for (const [i, path] of list.entries()) {
    const left = end - Date.now()
    if (left <= 0) {
      result.deadlineReached = true
      result.skipped += list.length - i
      break
    }
    let url: URL
    try {
      if (!isSafePath(path)) throw new Error('not a path')
      url = new URL(path, origin)
      if (url.origin !== origin) throw new Error('left the site')
    } catch {
      result.failed += 1
      continue
    }
    result.attempted += 1
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(Math.min(each, left)), redirect: 'manual', headers: { 'User-Agent': 'payload-plugin-cache-refresh' } })
      await res.body?.cancel()
      if (res.ok) result.ok += 1
      else result.failed += 1
    } catch (err) {
      if ((err as Error)?.name === 'TimeoutError' || (err as Error)?.name === 'AbortError') result.timedOut += 1
      else result.failed += 1
    }
  }
  return result
}

/**
 * CSRF: a cross-site form can send text/plain without a preflight, so the body must say it is JSON, and the
 * browser must say the request came from this site. No evidence either way means no.
 */
function checkSameSite(req: PayloadRequest, allowed: string[]): void {
  const h = req.headers
  const type = (h?.get?.('content-type') ?? '').split(';')[0]!.trim().toLowerCase()
  if (type !== 'application/json') return refuse('Send the request as application/json.', 415, 'contentType')
  const fetchSite = h?.get?.('sec-fetch-site')
  const origin = h?.get?.('origin')
  if (fetchSite && fetchSite !== 'same-origin') return refuse('The request did not come from this site.', 403, 'crossSite')
  if (origin) {
    if (!allowed.includes(origin)) return refuse('The request did not come from this site.', 403, 'crossSite')
  } else if (fetchSite !== 'same-origin') {
    return refuse('The request did not say where it came from.', 403, 'crossSite')
  }
}

const originOf = (u: string | undefined): string | null => {
  try {
    return u ? new URL(u).origin : null
  } catch {
    return null
  }
}

const profileFor = (mode: RefreshMode, profile: TagProfile | undefined): TagProfile => (mode === 'expire' ? { expire: 0 } : (profile ?? 'max'))

export function makeEndpoints(opts: CacheRefreshOptions, serverURL?: string): Endpoint[] {
  const path = opts.endpointPath ?? DEFAULT_PATH
  const mode: RefreshMode = opts.mode === 'expire' ? 'expire' : 'stale'
  const cooldown = opts.cooldownMs ?? 5000
  let running = false
  let lastEnd = 0
  const configured = (opts.allowedOrigins ?? [serverURL]).map(originOf).filter((o): o is string => Boolean(o))

  /** GET: what the button shows. Same guard as the refresh. */
  const status: Endpoint = {
    path,
    method: 'get',
    handler: async (req) => {
      await guard(req, opts)
      let changedCount: number | null = null
      if (opts.changedTags) {
        try {
          changedCount = cleanTags(await opts.changedTags({ req })).length
        } catch {
          changedCount = null
        }
      }
      return json({ allowed: true, mode, hasChanged: Boolean(opts.changedTags), changedCount, warms: Boolean(opts.warmPaths && opts.warmBaseUrl) })
    },
  }

  /** POST `{ confirm: true, scope?: 'changed' | 'all' }`: refresh. Without `confirm: true` nothing happens. */
  const refresh: Endpoint = {
    path,
    method: 'post',
    handler: async (req) => {
      const who = await guard(req, opts)
      checkSameSite(req, configured.length > 0 ? configured : [originOf(req.url)].filter((o): o is string => Boolean(o)))
      const body = await readBody(req)
      if (body.confirm !== true) return refuse('Confirm the refresh first.', 400, 'confirm')
      const scope: Scope = body.scope === 'all' || !opts.changedTags ? 'all' : 'changed'

      if (running) return refuse('A refresh is already running.', 429, 'busy')
      if (Date.now() - lastEnd < cooldown) return refuse('A refresh just finished. Wait a few seconds.', 429, 'cooldown')
      running = true
      try {
        let tags: string[]
        try {
          tags = await resolveTags(req, opts, scope)
        } catch (err) {
          req.payload?.logger?.error?.(`cache-refresh: the tag list failed, nothing was refreshed: ${(err as Error).message}`)
          return refuse('The list of tags could not be read, so nothing was refreshed.', 500, 'tags')
        }

        if (tags.length > 0) {
          const { revalidateTag } = await import('next/cache.js')
          const profile = profileFor(mode, opts.profile)
          for (const tag of tags) revalidateTag(tag, profile)
        }

        const at = new Date().toISOString()
        let audited = true
        if (tags.length > 0 && opts.onRefresh) {
          try {
            await opts.onRefresh({ who, at, count: tags.length, scope, mode, tags })
          } catch (err) {
            audited = false
            req.payload?.logger?.error?.(`cache-refresh: onRefresh failed after the refresh: ${(err as Error).message}`)
          }
        }

        const warmed = tags.length > 0 ? await warm(req, opts, tags, scope) : { attempted: 0, ok: 0, failed: 0, timedOut: 0, skipped: 0, deadlineReached: false }
        return json({ refreshed: true, count: tags.length, scope, mode, at, audited, warmed })
      } finally {
        running = false
        lastEnd = Date.now()
      }
    },
  }

  return [status, refresh]
}

export const cacheRefreshPlugin =
  (opts: CacheRefreshOptions): Plugin =>
  (incoming: Config): Config => {
    if (typeof opts?.canRefresh !== 'function') throw new Error('payload-plugin-cache-refresh: `canRefresh` is required. Nobody may refresh until the host says who.')
    if (!opts.tags) throw new Error('payload-plugin-cache-refresh: `tags` is required.')
    const components = incoming.admin?.components
    return {
      ...incoming,
      endpoints: [...(incoming.endpoints ?? []), ...makeEndpoints(opts, incoming.serverURL)],
      admin:
        opts.adminButton === false
          ? incoming.admin
          : { ...incoming.admin, components: { ...components, beforeDashboard: [...(components?.beforeDashboard ?? []), BUTTON] } },
    }
  }

export default cacheRefreshPlugin
