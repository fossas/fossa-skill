# Scan status and issues

## Is my scan done?

Scans are produced by the FOSSA CLI (`fossa analyze -p <project> -r <revision>`) or the GitHub/Quick-Import integrations; small projects often finish before your first poll, so poll immediately rather than sleeping first. "Done" has three stages, each with its own endpoint. `{REV}` = URL-encoded revision locator (`custom+1234/my-project$main`). These are the same endpoints the official `fossa` CLI polls for `fossa test` — stable for years, but not in the published API spec.

**Stage 1 — analysis/build finished:**

```
GET /api/cli/{REV}/latest_build
```

Response: `{ "id": …, "task": { "status": "SUCCEEDED" | "FAILED" | "CREATED" | "ASSIGNED" | "RUNNING" }, "error": … }`. Poll until `SUCCEEDED` (or `FAILED` — surface `error` to the user).

**Stage 2 — issue scan finished (this is what `fossa test` gates on):**

```
GET /api/cli/{REV}/issues
```

Response: `{ "count": N, "status": "WAITING" | "SCANNED", "issues": […] }`. Poll while `WAITING`. When `SCANNED`, `count` > 0 means policy-flagged issues exist. Note: **push-only tokens get counts but not issue details** — use a full token to read the issues themselves.

**Stage 3 — dependency cache ready (only needed before pulling reports):**

```
GET /api/cli/{REV}/dependencies-cache/status
```

Response: `{ "status": "WAITING" | "READY" }`. Generate attribution reports only after `READY` — earlier pulls can be incomplete.

Polling recipe (the CLI's own cadence is a few seconds between polls; be patient — large scans take minutes):

```bash
REV=$(enc 'custom+1234/my-project$main')
while :; do
  S=$(curl -s -H "Authorization: Bearer $FOSSA_API_KEY" \
    "https://app.fossa.com/api/cli/$REV/issues" | jq -r .status)
  [ "$S" = "SCANNED" ] && break
  sleep 10
done
```

## Listing issues (dashboard-grade filtering) — documented

```
GET /api/v2/issues?category={licensing|vulnerability|quality}&count=100&page=1
```

- **`category` is required** — omitting it is a 400 validation error.
- **Per-project issue counts, the easy way**: `GET /api/v2/projects?title={name}` returns each project with inline counts — `"issues": {"total", "licensing", "security", "quality"}` — one call (live-verified).
- Scope the list server-side with `scope[type]=global|project|releaseGroup` (same scoping the FOSSA UI's issues page URL carries): `project` takes the **URL-encoded project locator** as `scope[id]`, optionally narrowed with `scope[revision]={revision id}` (both live-verified); `releaseGroup` takes numeric `scope[id]` + `scope[release]` — an "expected number, received NaN" validation error means your params matched that numeric branch (or `ids[]`/`teamId`), not that locators are unsupported. Filter by `status`, `severity` (e.g. `severity[]=critical`), package managers, labels, dates; `sort` supported.
- Response: `{ "issues": [ { "id", "type", "source", "projects", "statuses", "license", "createdAt", "url", … } ], "total": … }`. `source` is the offending dependency; `projects` is where it appears.
- **A 202 response means the underlying scan is still running** — this endpoint tells you to come back, it is not an error.
- `csv=true` streams the same result as CSV — handy for handing a triage sheet to a human.
- Single issue: `GET /api/v2/issues/{issueId}`.
- **The list body has NO total count** — count via `GET /api/v2/issues/statuses` (same category/scope/filter params) → `{"issues": {"active", "ignored"}, "revisions": {...}}`; `issues` = issue instances, `revisions` = affected packages (different numbers — pick deliberately).
- Filters nest under `filter[...]`: `filter[severity][]` (critical|high|medium|low|unknown), `filter[hasFix][]` (has_fix|no_fix), `filter[type][]`, `filter[depths][]` (direct|deep), `filter[containerLayers][]` (**`baseLayer`|`otherLayer`** — note the deps endpoint spells the same idea `layerDepth[]=base|other`), `filter[packageManagers][]`, `filter[search]`, `filter[foundAfter]`/`filter[foundBefore]`, `filter[epss][...]`, CVSS vector filters, `filter[ignoreReason][]`. Values within one key OR; keys AND.
- **Do NOT use `filter[projectLabels][]` or `filter[licenses][]` here — they are silently ignored** (accepted, stripped, results unfiltered; verified at source). License-dimension counts come from `/api/v2/issues/license-list`; label-scoped counting goes through the projects API.
- Date filters accept any JS-Date-parseable string (`07/01/2026` works like ISO) but **garbage strings return HTTP 500** — send ISO 8601.
- Pagination: `count` default 20, silently clamped to [5, 1000]; loop pages (no total in body — see `/statuses` above).

Issue `type` values you'll meet in licensing work: `unlicensed_dependency` (no license found), `policy_flag` (license denied by policy), `policy_conflict`. Fixing `unlicensed_dependency` properly = give the dep a license (see `license-corrections.md`), not ignoring it.

## Ignoring / unignoring issues — documented

Bulk mutation endpoint (this is what the dashboard's ignore button calls):

```
PUT /api/v2/issues/?category={category}&ids[]={issueId}
```

**The body is the bare action; the target selection goes in the query string** (`category` is required there, like the list endpoint):

```json
{ "type": "ignore", "reason": "…", "notes": "…" }
```

```bash
curl -s -X PUT -H "Authorization: Bearer $FOSSA_API_KEY" -H "Content-Type: application/json" \
  "https://app.fossa.com/api/v2/issues/?category=licensing&ids[]=10122069" \
  -d '{"type":"ignore","reason":"…","notes":"…"}'
```

- `type`: `"ignore"` | `"unignore"` (also `"issueException"` for exception rules).
- **Blast radius — an issue id spans projects.** A v2 issue id aggregates every instance of that issue across your org (`statuses: {"active": N, "ignored": M}` counts them). An `ids[]`-only ignore flips **all instances org-wide** — the response's `count` tells you how many it touched (live-verified: one id, 49 instances, all flipped). To suppress only one project's instance, add `scope[type]=project&scope[id]={url-encoded project locator}` to the query (verified: `count: 1`, other projects untouched). `scope.type` on the mutation accepts `project`, `global`, or `releaseGroup` — `revision` is not a scope type (narrow a project scope with `scope[revision]` instead).
- **Always target explicit `ids[]` you have read first.** Omitting `ids[]` targets _everything matching the query filters_ — powerful for "ignore all issues from this dep across projects," dangerous when the filter is broader than you think. Read the list with the same query, show the user the count, then mutate.
- Ignoring an issue suppresses it; it does not fix the underlying data. If the real problem is a wrong/missing license, correct the license instead — the issue then clears on rescan with the data actually right.

## Verify after mutating

Re-run the same `GET /api/v2/issues` query and confirm the count moved as expected. Issue state changes are fast (unlike license-correction rescans, which queue — see `license-corrections.md`).
