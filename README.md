# payload-plugin-cache-refresh

Cache refresh for Payload: a dashboard button that refreshes your Next.js site's cache tags, for the people you choose, after a confirmation.

**Status:** early, version 0.1.0, not published. The endpoint is covered by 61 unit tests with `next/cache.js` mocked: who may refresh, the same-site check, the lock and cooldown, the confirmation step, a failing tag list, the audit hook, stale or expire, changed tags or everything, and warming. It has not been run against a real Next.js app yet, the button has not been rendered in a browser, and the screen reader behavior is untested.

## What it does

- Adds a **Refresh site cache** button to the admin dashboard, shown only to users your `canRefresh` function allows.
- Asks to confirm. The endpoint refuses to do anything until it is sent `confirm: true`, so the confirmation holds for API calls too.
- Calls `revalidateTag` for each tag you give it. It knows nothing about your tag names, routes or roles.
- Refreshes in stale-while-revalidate mode by default: pages keep showing while they rebuild. An option expires them at once instead.
- If you give it `changedTags`, the button refreshes only those by default. The admin can choose Everything.
- Can fetch a list of pages once after a refresh, one at a time, each with a timeout and all inside one deadline, so they are rebuilt before a visitor arrives. The reply says how many pages warmed, failed, timed out or were skipped. A failed fetch never fails the refresh.
- Calls `onRefresh` with who, when and how many, for your audit trail.

Signed-out requests get 401. A signed-in user your rule refuses gets 403, and a rule that throws counts as a no. Payload's own auth applies to the endpoint.

Payload's CSRF check does not cover this endpoint: a form on another site can post `text/plain` with the admin's cookie and no preflight. So the plugin checks the request itself. The refresh needs `Content-Type: application/json` (415 otherwise), and the browser must show it came from this site: `Sec-Fetch-Site` must be `same-origin` if sent, and `Origin` must match the allowed origins if sent. A request with neither header gets 403. The allowed origins are `allowedOrigins`, else Payload's `serverURL`, else the origin of the request URL. Set one of the first two if a proxy changes the request URL.

A second press while a refresh runs, or within `cooldownMs` after one, gets 429.

If the tag list can't be read (a function throws, or a tag is empty or longer than 256 characters), nothing is refreshed.

## Install

```sh
npm install @extantape/payload-plugin-cache-refresh
```

Needs Payload 3.80 or later and Next.js 16 or later, which has the two-argument `revalidateTag`.

```ts
import { cacheRefreshPlugin } from '@extantape/payload-plugin-cache-refresh'

export default buildConfig({
  plugins: [
    cacheRefreshPlugin({
      canRefresh: (req) => req.user?.role === 'admin',
      tags: ['pages', 'posts', 'menu'],
    }),
  ],
})
```

Regenerate Payload's import map after adding it, so the button is found.

## Options

| Option | What it does |
| --- | --- |
| `canRefresh(req)` | Required. Returns true for users who may refresh. |
| `tags` | Required. A list, or an async function returning one. What Everything refreshes. |
| `changedTags({ req })` | Tags changed since the last refresh, for example ones your scripts recorded. When given, the button offers Only what changed (the default) and Everything. |
| `mode` | `'stale'` (default) or `'expire'`. Stale calls `revalidateTag(tag, profile)`. Expire calls `revalidateTag(tag, { expire: 0 })`, so the next visit waits for a fresh page. |
| `profile` | The profile for stale mode. Default `'max'`. |
| `warmPaths` | A list of paths, or a function returning one, fetched after a refresh. A path starts with a single `/` and has no backslash. Anything else, such as `//host` or `/\host`, is refused and counted as failed. The URL is built on `warmBaseUrl` and its origin is checked again before the fetch. Redirects are not followed. |
| `warmBaseUrl` | The site's address, such as `https://example.org`. Warming is off without it. |
| `warmTimeoutMs` | Time for each warming fetch. Default 5000. |
| `warmDeadlineMs` | Total time for all warming. Pages left when it passes are skipped and reported. Default 15000. |
| `cooldownMs` | Time after a refresh before the next is accepted. Default 5000. |
| `allowedOrigins` | Origins a refresh may come from. Default Payload's `serverURL`, else the request's origin. |
| `onRefresh(report)` | Gets `who` (id, collection, email), `at`, `count`, `scope`, `mode` and `tags`. If it throws, the refresh stays and the response says `audited: false`. It isn't called when zero tags were refreshed. |
| `endpointPath` | Default `/cache-refresh`. |
| `adminButton` | Default true. Set false and import `CacheRefreshButton` from `@extantape/payload-plugin-cache-refresh/client` to place it yourself. |

The plugin never clears your recorded changed tags. Do that in `onRefresh`, which receives the tags it refreshed.

The button's words can be replaced with the `text` prop, and its colors with `--cache-refresh-ink`, `--cache-refresh-paper`, `--cache-refresh-line` and `--cache-refresh-focus`.

## Limits

- A refresh is a request to Next.js, and in stale mode the rebuild happens when a page is next visited. Warming is how you bring that forward.
- Expiry is not undone if a later step fails. The tag list is checked first for that reason.
- The lock and cooldown live in one server process. Several instances each keep their own.
- It refreshes the cache of the Next.js process serving the request. Other servers or a CDN in front need their own handling.

## License

MIT. Copyright (c) 2026 EXTANT APE.
