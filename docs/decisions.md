# Decisions

Dated decisions for this repo, newest last.

- 2026-11-19: created from the ops starter kit, area `co-plugins`.
- 2026-11-20: the plugin is built as a general Payload plugin (MIT, agnostic of any app's tag scheme, routes or roles) after the owner chose "Create it" and "Garfunkel via co/ PR" (bottles 71 and 66). Refresh behavior follows the owner's choice for Captive Origins' cache button on 2026-11-20 (K5158): stale-while-revalidate by default, a targeted refresh of changed tags with Everything as the choice, and optional best-effort warming. Each is a host option.
- 2026-11-20: design choices. The confirmation is enforced by the endpoint (`confirm: true`), not only the button. A tag list that throws or holds a bad tag refuses the whole refresh before any tag is expired. `onRefresh` runs after the refresh, so a failure there is reported (`audited: false`) and never undoes it, and it isn't called for zero tags. Warm paths must start with `/` and are joined to `warmBaseUrl`. Next.js 16 or later is a peer dependency for the two-argument `revalidateTag`.
- 2026-11-20: review fixes (bottle 75). The POST fails closed on cross-site requests: JSON content type required, and a matching `Origin` or `Sec-Fetch-Site: same-origin`, because Payload's CSRF check does not stop a `text/plain` form post. Warm paths accept a single leading `/` and no backslash, checked again by origin after the URL is built. A per-process lock and a 5 second cooldown stop stacked presses. Warming has a 15 second total deadline, and the reply reports what warmed, failed, timed out or was skipped.
