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
- Update revision metadata (link, author): `PATCH /api/revisions/{REV}` (documented). Note there is no useful bare GET on that exact path in the current API docs; for package metadata use the endpoints in `packages.md`.

## Teams

Teams scope projects for filtering and RBAC. **`fossa analyze -T/--team <name>` does not create the team — an unknown name FAILS the upload.** The upload handler always throws 404 `specified team '<name>' not found` (`modules/customBuildUploadHandler.ts:87-93`); on orgs with preflight checks the CLI fails earlier with the same error via `GET /api/cli/custom_build_permissions` (`routes/cli/permissions.ts:50-62`; `fossa-cli src/App/Fossa/PreflightChecks.hs:74-79`). Nothing lands. Create first, then tag:

```
GET  /api/teams                # [{ id, name, organizationId, defaultRoleId, autoAddUsers, teamUsers, teamProjectsCount, teamReleaseGroupsCount, … }]
                               #   (deprecated in favour of the paginated GET /api/v2/teams — routes/teams.ts:95-97)
POST /api/teams                # { "name", "autoAddUsers": false, "defaultRoleId" }   (informal — the dashboard's route)
GET  /api/teams/{id}           # one team, plus teamProjects: [{ projectId, … }], teamUsers: [{ userId, roleId }], teamReleaseGroups
PUT  /api/teams/{id}           # rename / settings
PUT  /api/teams/{id}/projects  # { "action": "add" | "remove" | "replace", "projects": ["<project locator>", …] | "all" }   ⚠ see below
```

- `defaultRoleId` is the org's team role id — copy it from an existing team in the list or `GET /api/roles` (a "Team Viewer"-style role); ids differ per org.
- Creating is permission-gated (`routes/teams.ts:179` → 403 without the team-create permission; a push-only token was observed to 403).
- **Assigning existing projects: `PUT /api/teams/{id}/projects` and ALWAYS send `"action": "add"`.** Omitting `action` (or sending `"replace"`) **replaces the team's whole project set** — every project not in your list is unassigned (`TeamProject.destroy` by team, then bulk insert: `modules/RoleManager/teams.ts:343-364`; body / permission / execution switches at `routes/teams.ts:829-833, 868-884, 910-930`). `add` 403s if any locator is outside the org or the caller lacks Edit on it; the replace path needs add AND remove permission. `"remove"` is the inverse. Read-back: `{ id, projects: [locators] }`; unknown team = bare 404. New uploads take `-T "<name>"`. List a team's projects with `GET /api/v2/projects?teamId={id}` (`teamId=null` = unassigned).
- The project-update endpoint (`PUT /api/projects/{PROJECT}`) reads no team field (traced: `routes/projects/updateProject.ts`) — a team key there 200s and changes nothing.

(source: `routes/teams.ts` at FOSSA `22fc86d76b` — `GET /api/teams` :98-169, `POST /api/teams` :176-219 reads `name` / `autoAddUsers` / `defaultRoleId`, `PUT /api/teams/:id` :278, `GET /api/teams/:id` :294-310, `PUT /api/teams/:id/projects` :816-951. Live-observed 2026-09-16: create, `?teamId=` filter, the 403 on a push-only token; everything else traced, not observed.)

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
