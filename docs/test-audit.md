# Test audit

Kept by this repo's owning session, per `~/Code/CLAUDE.md`, "Test self-audits". Newest first.

## 2026-11-20: first audit (core)

- Promises: 401 signed out, 403 not allowed, fail closed on a throwing rule, confirmation before any expiry, no partial expiry on a bad tag list, `onRefresh` contents, stale by default and expire as an option, changed versus everything, warming never fails the refresh, warm paths stay on the host's base.
- Covered: all of the above, in `test/cache-refresh.test.ts` (32 tests, `next/cache` mocked).
- Gaps skipped (and why): the button component has no render test, because there is no DOM test setup yet and the endpoint holds every rule; the real `revalidateTag` needs a Next.js app. Both are listed as not tested in the changelog and README.


## 2026-11-19: first audit (starter kit)

- Promises: none yet.
- Covered: none yet.
- Gaps added: none.
- Gaps skipped (and why): none.
