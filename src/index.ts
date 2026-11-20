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

/** Fetches each path once, in order, with a timeout. Never throws. */
async function warm(req: PayloadRequest, opts: CacheRefreshOptions, tags: string[], scope: Scope): Promise<WarmResult> {
  const result: WarmResult = { attempted: 0, failed: 0 }
  if (!opts.warmPaths || !opts.warmBaseUrl) return result
  let paths: string[]
  try {
    paths = typeof opts.warmPaths === 'function' ? await opts.warmPaths({ req, tags, scope }) : opts.warmPaths
  } catch (err) {
    req.payload?.logger?.warn?.(`cache-refresh: the warm path list failed: ${(err as Error).message}`)
    return result
  }
  const timeout = opts.warmTimeoutMs ?? 5000
  for (const path of Array.isArray(paths) ? paths : []) {
    // Paths only: an absolute address could send the server's request somewhere the host never named.
    if (typeof path !== 'string' || !path.startsWith('/') || path.startsWith('//')) {
      result.failed += 1
      continue
    }
    result.attempted += 1
    try {
      const res = await fetch(new URL(path, opts.warmBaseUrl), { signal: AbortSignal.timeout(timeout), headers: { 'User-Agent': 'payload-plugin-cache-refresh' } })
      await res.body?.cancel()
      if (!res.ok) result.failed += 1
    } catch {
      result.failed += 1
    }
  }
  return result
}

const profileFor = (mode: RefreshMode, profile: TagProfile | undefined): TagProfile => (mode === 'expire' ? { expire: 0 } : (profile ?? 'max'))

export function makeEndpoints(opts: CacheRefreshOptions): Endpoint[] {
  const path = opts.endpointPath ?? DEFAULT_PATH
  const mode: RefreshMode = opts.mode === 'expire' ? 'expire' : 'stale'

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
      const body = await readBody(req)
      if (body.confirm !== true) return refuse('Confirm the refresh first.', 400, 'confirm')
      const scope: Scope = body.scope === 'all' || !opts.changedTags ? 'all' : 'changed'

      let tags: string[]
      try {
        tags = await resolveTags(req, opts, scope)
      } catch (err) {
        req.payload?.logger?.error?.(`cache-refresh: the tag list failed, nothing was refreshed: ${(err as Error).message}`)
        return refuse('The list of tags could not be read, so nothing was refreshed.', 500, 'tags')
      }

      if (tags.length > 0) {
        const { revalidateTag } = await import('next/cache')
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

      const warmed = tags.length > 0 ? await warm(req, opts, tags, scope) : { attempted: 0, failed: 0 }
      return json({ refreshed: true, count: tags.length, scope, mode, at, audited, warmed })
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
      endpoints: [...(incoming.endpoints ?? []), ...makeEndpoints(opts)],
      admin:
        opts.adminButton === false
          ? incoming.admin
          : { ...incoming.admin, components: { ...components, beforeDashboard: [...(components?.beforeDashboard ?? []), BUTTON] } },
    }
  }

export default cacheRefreshPlugin
