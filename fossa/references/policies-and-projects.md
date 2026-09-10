# Policies, projects, and release groups

## Policies

A policy is a set of rules (allow/flag/deny per license, plus security/quality rules) attached to projects. Types: `LICENSING`, `SECURITY`, `QUALITY`.

```
GET    /api/policies                # list all org policies (id, title, type, rules)
GET    /api/policies/{id}           # read one, including its rules
POST   /api/policies                # create — creates an EMPTY policy shell only, see below
PUT    /api/policies/{id}           # update TITLE/DESCRIPTION only — does NOT persist rules, see below
POST   /api/policies/{id}/rules     # add/update rule(s) — this is how rule content actually gets written
DELETE /api/policies/{id}/rules     # remove rule(s), body {"ruleIds": [...]}
DELETE /api/policies/{id}           # delete (premium feature)
```

- **`PUT /api/policies/{id}` does not persist rule content**, despite being the one endpoint in the published spec and despite echoing back `HTTP 200` with no error. Confirmed empirically (2026-09-10): sending a full policy object (with or without existing `ruleId`s, stripped or round-tripped verbatim from a prior `GET`) always comes back with `rules` either wiped to `[]` (when the policy started empty) or silently unchanged (when it already had rules — existing rules survive, but any rule-field edit in the request, e.g. `notes`, is ignored). `rulesHash` in the response's `latestVersion` stays exactly as it was before the call either way — the clearest tell that the server never actually processed the rules array.
- **The actual mechanism is `POST /api/policies/{id}/rules`**, one rule (or a batch) at a time — body `{"type": "approved_license"|"denied_license"|"flagged_license", "licenseId": "<SPDX id>"}` (matches the shape a rule has under `GET`, minus the server-assigned fields). Confirmed working: creates the rule, and `rulesHash`/`latestVersionId` genuinely update. Symmetric with the already-documented `DELETE /api/policies/{id}/rules` below (which was previously only noted for `blacklisted_dependency`/quality rules, but the same sub-resource works for licensing rule types too).
- **A brand-new policy's `defaultAction` is `"APPROVE"`** — an uncategorized license (no explicit rule) is treated as approved. You only need rules for licenses you want to *deviate* from that default, not the full ~1023-license catalog.
- Practical flow for setting up a new policy from the API: `POST /api/policies` (empty shell) → one or more `POST /api/policies/{id}/rules` calls for just the licenses that need a non-default action → attach to a project via `PUT /api/projects/{PROJECT}` (below).
- The common flow is _resolve name → id, then act_: list policies, match on `title`, use the `id`. (FOSSA's own CLI does exactly this when creating release groups.)
- **Policy edits are org-visible and affect issue scans on every project using the policy.** Read the policy first, show the user what will change, and prefer additive rule changes (one `POST .../rules` call per license) over wholesale replaces.
- To change which policy a _project_ uses, update the project (below) rather than editing the policy.

## Projects

```
GET /api/projects?count=100&page=1     # list org projects (informal; the documented list is GET /api/v2/projects)
GET /api/projects/{PROJECT}            # one project — settings, default branch, policy ids
PUT /api/projects/{PROJECT}            # update settings (title, policy ids, default branch…)
GET /api/projects/{PROJECT}/revisions  # list scanned revisions (newest first)
```

`{PROJECT}` = URL-encoded **project** locator (no `$revision`), e.g. `custom+1234/github.com/acme/api-server`.

- **Policy attachment fields are singular and type-specific, not a `policies` array**: `policyId` (LICENSING), `securityPolicyId`, `qualityPolicyId`, `sbomPolicyId` — set the one(s) you want via `PUT`, e.g. `{"policyId": 269165}`. Confirmed working (2026-09-10): verified with a reversible round-trip — `updatedAt` and the field both changed on `PUT`, held on a fresh `GET`, checked with a different policy id and then reverted. A `GET` response has no top-level `policies` field at all; querying one (as an earlier version of this doc suggested) always silently returns nothing, which looks exactly like a failed write but isn't one.
- **v2 list filters** (flat params): `title` (case-insensitive substring), `labels[]` (label NAMES, case-insensitive, any-match), `type[]` (container|archive|provided|autobuild|sbom|binary), `teamId` (id, array, or literal `null` = unassigned), `locators[]` (exact), `latestScan`/`lastRevisionWithin` (days), `sort` (`title_asc/desc`, `latest-scan_asc/desc`, `issues-total_asc/desc`, …; default latest-scan_desc). Response `{projects, total}` — `total` ignores pagination. `count` default 10, clamped [1, 1000]. There is NO policy filter on the list.
- v1 `GET /api/projects` differs entirely: `fetcher=` prefix filter, `offset` (not page), default count 5000, bare-array response with the total only in the `content-range` header.
- Find a project from a human name: v2 `title=` filter, confirm with the user when more than one matches.
- The revisions response is **grouped by branch**: `{ "branch": { "master": [ { "locator": "custom+…$…", "revision_timestamp": …, "resolved": … } ] } }`. Take the newest entry of the branch you care about — its `locator` is the revision locator you need for issues/reports.
- Update revision metadata (link, author): `PATCH /api/revisions/{REV}` (documented). Note there is no useful bare GET on that exact path in the current API docs; for package metadata use the endpoints in `packages.md`.

## Release groups

Release groups aggregate multiple projects into one releasable unit with shared policies — and support release-wide reports. Documented in the published spec.

**Create a release group** (with its first release):

```
POST /api/project_group
```

Body essentials: `title`, first release info (`release` title + `projects` in the same `{projectId, revisionId, branch}` shape defined below), and optionally `licensingPolicyId` / `securityPolicyId` / `qualityPolicyId` (resolve ids from `GET /api/policies`).

**Add a release to an existing group:**

```
POST /api/project_group/{groupId}/release
```

Body: release `title` + `projects: [{projectId, revisionId, branch}, …]` — where `projectId` is the **project locator** string (`custom+1234/my-service`) and `revisionId` is the **full revision locator** (`custom+1234/my-service$main`). One revision per project (duplicate `projectId`s are rejected).

**Add or remove projects on an existing release:**

```
PUT /api/project_group/{groupId}/release/{releaseId}
```

Body: `{ "title": …, "projects": [{projectId, revisionId, branch}, …], "projectsToDelete": ["custom+1234/old-service", …] }`.

- The `projects` you send are **added or updated** (matched by `projectId`); projects you omit are left untouched — to _add_ one project, send just that one.
- Removal is explicit: list the project locators in `projectsToDelete`. A project can't appear in both arrays (400).
- Re-sending an existing project (e.g. with a new `revisionId`) updates it and queues a rescan of it within the release.

**Read:**

```
GET /api/project_group                          # list groups
GET /api/project_group/{groupId}                # one group + its releases
GET /api/project_group/{groupId}/all_projects   # every project across the group
```

**Release-wide attribution report (async job + poll)** — the release-group counterpart of the revision reports in `reports.md`:

```
POST /api/project_group/{groupId}/release/{releaseId}/attribution/{FORMAT}
  → { "taskId": … }
GET  /api/project_group/attribution/{taskId}
  → { "status": "CREATED"|"ASSIGNED"|"RUNNING"|"SUCCEEDED"|"FAILED", "url": … }
```

Poll until `SUCCEEDED`, then download from `url`. Release-group reports cover _all_ projects in the release — the right artifact when a customer ships a product composed of many scanned components.
