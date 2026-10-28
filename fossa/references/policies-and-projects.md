# Policies, projects, and release groups

## Policies

A policy is a set of rules (allow/flag/deny per license, plus security/quality rules) attached to projects. Types: `LICENSING`, `SECURITY`, `QUALITY`.

```
GET  /api/policies              # list all org policies (id, title, type, rules)
GET  /api/policies/{id}         # read one, including its rules
POST /api/policies              # create
PUT  /api/policies/{id}         # update (title, rules) — the documented one
DELETE /api/policies/{id}       # delete (premium feature)
```

- Only `PUT /api/policies/{id}` is in the published API spec; the rest are the same endpoints the dashboard uses (stable, informal).
- The common flow is _resolve name → id, then act_: list policies, match on `title`, use the `id`. (FOSSA's own CLI does exactly this when creating release groups.)
- **Policy edits are org-visible and affect issue scans on every project using the policy.** Read the policy first, show the user what will change, and prefer additive rule changes over wholesale replaces of a rules array you haven't fully read.
- To change which policy a _project_ uses, update the project (below) rather than editing the policy.

## Projects

```
GET /api/projects?count=100&page=1     # list org projects (informal; the documented list is GET /api/v2/projects)
GET /api/projects/{PROJECT}            # one project — settings, default branch, policy ids
PUT /api/projects/{PROJECT}            # update settings (title, policies, default branch…)
GET /api/projects/{PROJECT}/revisions  # list scanned revisions (newest first)
```

`{PROJECT}` = URL-encoded **project** locator (no `$revision`), e.g. `custom+1234/github.com/acme/api-server`.

- **v2 list filters** (flat params): `title` (case-insensitive substring), `labels[]` (label NAMES, case-insensitive, any-match), `type[]` (container|archive|provided|autobuild|sbom|binary), `teamId` (id, array, or literal `null` = unassigned), `locators[]` (exact), `latestScan`/`lastRevisionWithin` (days), `sort` (`title_asc/desc`, `latest-scan_asc/desc`, `issues-total_asc/desc`, …; default latest-scan_desc). Response `{projects, total}` — `total` ignores pagination. `count` default 10, clamped [1, 1000]. There is NO policy filter on the list.
- v1 `GET /api/projects` differs entirely: `fetcher=` prefix filter, `offset` (not page), default count 5000, bare-array response with the total only in the `content-range` header.
- Find a project from a human name: v2 `title=` filter, confirm with the user when more than one matches.
- The revisions response is **grouped by branch**: `{ "branch": { "master": [ { "locator": "custom+…$…", "revision_timestamp": …, "resolved": … } ] } }`. Take the newest entry of the branch you care about — its `locator` is the revision locator you need for issues/reports.
- `PUT /api/projects/{PROJECT}` can only _clear_ a project's public-report id: a non-empty `bom_public_id` in the body is silently dropped, `""`/`null` stores NULL (`routes/projects/updateProject.ts:343-349`, since FOSSA `de507a5b4e`); the id is generated server-side only. An empty `title` or an empty `default_branch` (when one is stored) is rejected with 400 (`routes/projects/utils.ts:27-36`).
- Update revision metadata (link, author): `PATCH /api/revisions/{REV}` (documented). Note there is no useful bare GET on that exact path in the current API docs; for package metadata use the endpoints in `packages.md`.

## Teams

Teams scope projects for filtering and RBAC. **`fossa analyze -T/--team <name>` does not create the team — an unknown name FAILS the upload.** The upload handler always throws 404 `specified team '<name>' not found` (`modules/customBuildUploadHandler.ts:87-93`); on orgs with preflight checks the CLI fails earlier with the same error via `GET /api/cli/custom_build_permissions` (`routes/cli/permissions.ts:50-62`; `fossa-cli src/App/Fossa/PreflightChecks.hs:74-79`). Nothing lands. Create first, then tag:

```
GET  /api/teams                # [{ id, name, organizationId, defaultRoleId, autoAddUsers, teamUsers, teamProjectsCount, teamReleaseGroupsCount, … }]
                               #   (deprecated in favour of the paginated GET /api/v2/teams — routes/teams.ts:139-141)
POST /api/teams                # { "name", "autoAddUsers": false, "defaultRoleId", "uniqueIdentifier"?, "teamGroupIds"? }   (informal — the dashboard's route; the two optional keys are a stable external id and the team-groups path, routes/teams.ts:229-302 — `teamGroupIds` requires the TEAM_GROUPS feature; without it the key is silently ignored and the team is created with a 200, routes/teams.ts:303-312)
GET  /api/teams/{id}           # one team, plus teamProjects: [{ projectId, … }], teamUsers: [{ userId, roleId }], teamReleaseGroups
PUT  /api/teams/{id}           # rename / settings
PUT  /api/teams/{id}/projects  # { "action": "add" | "remove" | "replace", "projects": ["<project locator>", …] | "all" }   ⚠ see below
```

- `defaultRoleId` is the org's team role id — copy it from an existing team in the list or `GET /api/roles` (a "Team Viewer"-style role); ids differ per org.
- Creating is permission-gated (`routes/teams.ts:223` → 403 without the team-create permission; a push-only token was observed to 403).
- **Assigning existing projects: `PUT /api/teams/{id}/projects` and ALWAYS send `"action": "add"`.** Omitting `action` (or sending `"replace"`) **replaces the team's whole project set** — every project not in your list is unassigned (`deleteAllTeamProjects` for the team, then `insertTeamProjects`: `modules/RoleManager/teams.ts:366-392`; body / permission / execution switches at `routes/teams.ts:862-866, 903-919, 945-968`). `add` 403s if any locator is outside the org or the caller lacks Edit on it; the replace path needs add AND remove permission. `"remove"` is the inverse. Read-back: `{ id, projects: [locators] }`; unknown team = bare 404. New uploads take `-T "<name>"`. List a team's projects with `GET /api/v2/projects?teamId={id}` (`teamId=null` = unassigned).
- The project-update endpoint (`PUT /api/projects/{PROJECT}`) reads no team field (traced: `routes/projects/updateProject.ts`) — a team key there 200s and changes nothing.

(source: `routes/teams.ts` at FOSSA develop `5a248a1963`, re-pinned 2026-10-28 — the earlier `22fc86d76b` pin was a prototype-branch snapshot, not develop — `GET /api/teams` :142-219, `POST /api/teams` :220-321 reads `name` / `autoAddUsers` / `defaultRoleId` / `uniqueIdentifier` (:261-264, :306-309; `teamGroupIds` branch :229-302, flag-gated at :229-230, ignored without TEAM_GROUPS via the else branch :303-312), `PUT /api/teams/:id` :322-337, `GET /api/teams/:id` :338-395, `PUT /api/teams/:id/projects` :850-993. Live-observed 2026-09-16: create, `?teamId=` filter, the 403 on a push-only token; everything else traced, not observed.)

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
GET /api/project_group/{groupId}/releases?count=25&page=1   # the releases, paginated: { releases: [{ id, title, dependency_count, license_count, unresolved_*_issue_count, … }] }
GET /api/project_group/{groupId}/all_projects   # every project across the group
GET /api/v2/release-groups?count=10&page=1      # documented list: { releaseGroups: [{ id, title, issues, scanned, projects, publicOnPortal }], total }
GET /api/v2/release-groups/{id}                 # documented since 2026-10 (CORE-7690): the group WITHOUT its releases —
                                                #   { id, title, organizationId, publicOnPortal, policyId, securityPolicyId, qualityPolicyId, reportCustomText, … }
```

(`routes/releaseGroupsV2/index.ts:42-86`, `docs/swagger/paths/releaseGroups/getReleaseGroupByIdV2.yaml`; both v2 shapes live-verified 2026-10-15 on org 32098. The v2 GET 404s for another org's id and 403s on a push-only token; pair it with `/releases` for the release list.)

**Release-wide attribution report (async job + poll)** — the release-group counterpart of the revision reports in `reports.md`:

```
POST /api/project_group/{groupId}/release/{releaseId}/attribution/{FORMAT}
  → { "taskId": …, "reportId": "<uuid>" }
GET  /api/project_group/attribution/{taskId}
  → { "status": "CREATED"|"ASSIGNED"|"RUNNING"|"SUCCEEDED"|"FAILED", "url": … }
```

Poll until `SUCCEEDED`, then download from `url` (a signed link minted on each poll — `routes/reports.ts:86-134`). Release-group reports cover _all_ projects in the release — the right artifact when a customer ships a product composed of many scanned components. Formats on this v1 route are `HTML, MD, PDF, CSV, TXT, SPDX, SPDX_JSON, CYCLONEDX_JSON, CYCLONEDX_XML` (no `JSON`, no `SPDX3_JSON` — `routes/projectGroups.ts:1483-1491`). Two queue variants (both **documented**, since 2026-10-14, FOSSA `87ac5bc981`): `delivery=download` (`email` by default) stores the report instead of emailing it and the response's `reportId` is then fetchable at `https://app.fossa.com/attribution/{reportId}?download=true` (outside `/api`; 302 to a signed URL — details and the not-ready behaviour in `reports.md`); it cannot be combined with `isPublishing`. The v1 POST and the v2 `GET /api/v2/project_group/{groupId}/release/{releaseId}/attribution/{FORMAT}` share the handler (`routes/projectGroups/reportsV2.ts:203, 434-453`); on v2, `preview=true` or `download=true` renders synchronously instead of queueing. ⚠ **The v2 route's queued `taskId` is the job token (a UUID — `reportsV2.ts:453`), not v1's numeric task id (`legacyIntegerTaskId`, `routes/projectGroups.ts:1531`)**: poll it with `GET /api/jobs/status?jobs[]={taskId}` (see `reports.md`), because `GET /api/project_group/attribution/{taskId}` runs `Number()` on the id and 404s `Invalid task ID` for a UUID (`routes/reports.ts:91-93`).
