# payload-plugin-cache-refresh

Cache refresh for Payload: a dashboard button that refreshes your Next.js site's cache tags, for the people you choose, after a confirmation.

**Status:** early, version 0.1.0, not published. The endpoint is covered by 32 unit tests with `next/cache` mocked: who may refresh, the confirmation step, a failing tag list, the audit hook, stale or expire, changed tags or everything, and warming. It has not been run against a real Next.js app yet, the button has not been rendered in a browser, and the screen reader behavior is untested.

## What it does

- Adds a **Refresh site cache** button to the admin dashboard, shown only to users your `canRefresh` function allows.
- Asks to confirm. The endpoint refuses to do anything until it is sent `confirm: true`, so the confirmation holds for API calls too.
- Calls `revalidateTag` for each tag you give it. It knows nothing about your tag names, routes or roles.
- Refreshes in stale-while-revalidate mode by default: pages keep showing while they rebuild. An option expires them at once instead.
- If you give it `changedTags`, the button refreshes only those by default. The admin can choose Everything.
- Can fetch a list of pages once after a refresh, one at a time with a short timeout, so they are rebuilt before a visitor arrives. A failed fetch never fails the refresh.
- Calls `onRefresh` with who, when and how many, for your audit trail.

Signed-out requests get 401. A signed-in user your rule refuses gets 403, and a rule that throws counts as a no. Payload's own auth applies to the endpoint, including its CSRF checks for cookie sign-in.

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
| `warmPaths` | A list of paths, or a function returning one, fetched after a refresh. Paths start with `/`. Full addresses are skipped. |
| `warmBaseUrl` | The site's address, such as `https://example.org`. Warming is off without it. |
| `warmTimeoutMs` | Time for each warming fetch. Default 5000. |
| `onRefresh(report)` | Gets `who` (id, collection, email), `at`, `count`, `scope`, `mode` and `tags`. If it throws, the refresh stays and the response says `audited: false`. It isn't called when zero tags were refreshed. |
| `endpointPath` | Default `/cache-refresh`. |
| `adminButton` | Default true. Set false and import `CacheRefreshButton` from `@extantape/payload-plugin-cache-refresh/client` to place it yourself. |

The plugin never clears your recorded changed tags. Do that in `onRefresh`, which receives the tags it refreshed.

The button's words can be replaced with the `text` prop, and its colors with `--cache-refresh-ink`, `--cache-refresh-paper`, `--cache-refresh-line` and `--cache-refresh-focus`.

## Limits

- A refresh is a request to Next.js, and in stale mode the rebuild happens when a page is next visited. Warming is how you bring that forward.
- Expiry is not undone if a later step fails. The tag list is checked first for that reason.
- It refreshes the cache of the Next.js process serving the request. Other servers or a CDN in front need their own handling.

## License

MIT. Copyright (c) 2026 EXTANT APE.
