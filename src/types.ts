import type { PayloadRequest } from 'payload'

/** What `revalidateTag` takes as its second argument: a cacheLife profile name (`'max'`) or `{ expire }` in seconds. */
export type TagProfile = string | { expire?: number }

/** A list of tags, or a function that returns one. Called per request, so it can read the database. */
export type TagSource = string[] | ((args: { req: PayloadRequest }) => string[] | Promise<string[]>)

/** A list of paths, or a function that returns one. Paths start with `/` and are fetched from `warmBaseUrl`. */
export type PathSource = string[] | ((args: { req: PayloadRequest; tags: string[]; scope: Scope }) => string[] | Promise<string[]>)

/** `changed`: only what `changedTags` returns. `all`: everything `tags` returns. */
export type Scope = 'changed' | 'all'

/**
 * `stale` (default): pages keep showing while they rebuild, `revalidateTag(tag, profile)`.
 * `expire`: the next visit waits for a fresh page, `revalidateTag(tag, { expire: 0 })`.
 */
export type RefreshMode = 'stale' | 'expire'

export type RefreshWho = { id: string | number; collection?: string; email?: string }

export type RefreshReport = {
  /** Who pressed the button. */
  who: RefreshWho
  /** When the refresh ran, as an ISO time. */
  at: string
  /** How many tags were refreshed. */
  count: number
  scope: Scope
  mode: RefreshMode
  /** The tags themselves, so the host can clear what it recorded for `changedTags`. */
  tags: string[]
}

export type WarmResult = {
  /** Fetches started. */
  attempted: number
  ok: number
  /** Bad status, network error, or a path that was refused. */
  failed: number
  /** Fetches that hit their time limit. */
  timedOut: number
  /** Paths never fetched: refused, or left when the deadline passed. */
  skipped: number
  deadlineReached: boolean
}

export type CacheRefreshOptions = {
  /** Who may refresh. Called with the request after sign-in is checked. Throwing counts as no. Required. */
  canRefresh: (req: PayloadRequest) => boolean | Promise<boolean>
  /** Every tag that "Everything" refreshes. A list, or a function that returns one. Required. */
  tags: TagSource
  /** Tags changed since the last refresh (for example, ones scripts recorded). Refreshed by default when given; the admin can pick Everything. */
  changedTags?: (args: { req: PayloadRequest }) => string[] | Promise<string[]>
  /** `stale` (default) or `expire`. */
  mode?: RefreshMode
  /** The profile for `stale` mode. Default `'max'`. Ignored in `expire` mode. */
  profile?: TagProfile
  /** Pages to fetch once after a refresh, to rebuild them before a visitor does. Best effort. */
  warmPaths?: PathSource
  /** The site's address for warming, such as `https://example.org`. Warming is skipped without it. */
  warmBaseUrl?: string
  /** Time allowed for each warming fetch, in milliseconds. Default 5000. */
  warmTimeoutMs?: number
  /** Total time allowed for all warming, in milliseconds. Paths left when it passes are skipped. Default 15000. */
  warmDeadlineMs?: number
  /** Minimum time between refreshes, in milliseconds. A second press during a refresh or this wait gets 429. Default 5000. */
  cooldownMs?: number
  /** Origins a refresh may come from, such as `https://admin.example.org`. Default: Payload's `serverURL`, else the request's own origin. */
  allowedOrigins?: string[]
  /** Called after a refresh with who, when and how many. A failure here is logged and reported, and never undoes the refresh. */
  onRefresh?: (report: RefreshReport) => void | Promise<void>
  /** The endpoint's path under Payload's API route. Default `/cache-refresh`. */
  endpointPath?: string
  /** Put the button on the dashboard. Default true. Set false to place `CacheRefreshButton` yourself. */
  adminButton?: boolean
}
