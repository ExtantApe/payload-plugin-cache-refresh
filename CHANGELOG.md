# Changelog

## Unreleased

- First version of the plugin: a dashboard button and a GET and POST endpoint (`/api/cache-refresh`) that refresh Next.js cache tags for users `canRefresh` allows. Refreshing needs `confirm: true` in the request. Default mode is stale-while-revalidate (`revalidateTag(tag, 'max')`), with `mode: 'expire'` for an immediate expire. `changedTags` gives a targeted refresh by default, with Everything one click away. `warmPaths` fetches pages after a refresh, one at a time, best effort. `onRefresh` receives who, when and how many.
- Follows the owner's choice for Captive Origins' cache button (K5158, 2026-11-20); see `docs/decisions.md`. The plugin itself names no app, tag, route or role.
- Tested: 32 unit tests with `next/cache` mocked (signed out 401, not allowed 403, a throwing `canRefresh`, the confirmation, a throwing or invalid tag list with no partial expiry, `onRefresh` contents, stale versus expire, changed versus everything, warming failures and timeouts, absolute warm paths skipped), typecheck and build.
- Not tested: a real Next.js app (the real `revalidateTag` and cache behavior), the button in a browser or with a screen reader, a real Payload server and its CSRF check, and Next.js versions other than 16.4.
