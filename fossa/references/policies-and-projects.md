# Policies, projects, teams, users, and release groups

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
                               #   teamProjectsCount is absent (not 0) on teams with no projects; unpaginated — see Lookups below
POST /api/teams                # { "name", "autoAddUsers": false, "defaultRoleId", "uniqueIdentifier"?, "teamGroupIds"? (team-groups feature) }   (documented)
GET  /api/teams/{id}           # one team, plus teamProjects: [{ projectId, … }], teamUsers: [{ userId, roleId }], teamReleaseGroups
PUT  /api/teams/{id}           # rename / settings (name, autoAddUsers, defaultRoleId, uniqueIdentifier)   (documented)
PUT  /api/teams/{id}/projects  # { "action": "add" | "remove" | "replace", "projects": ["<project locator>", …] | "all" }   ⚠ see below
```

- `defaultRoleId` is the org's team role id — copy it from an existing team in the list or `GET /api/roles` (a "Team Viewer"-style role); ids differ per org.
- Creating is permission-gated (`routes/teams.ts:179` → 403 without the team-create permission; a push-only token was observed to 403).
- **Assigning existing projects: `PUT /api/teams/{id}/projects` and ALWAYS send `"action": "add"`.** Omitting `action` (or sending `"replace"`) **replaces the team's whole project set** — every project not in your list is unassigned (`TeamProject.destroy` by team, then bulk insert: `modules/RoleManager/teams.ts:343-364`; body / permission / execution switches at `routes/teams.ts:829-833, 868-884, 910-930`). `add` 403s if any locator is outside the org or the caller lacks Edit on it; the replace path needs add AND remove permission. `"remove"` is the inverse. Read-back: `{ id, projects: [locators] }`; unknown team = bare 404. New uploads take `-T "<name>"`. List a team's projects with `GET /api/v2/projects?teamId={id}` (`teamId=null` = unassigned).
- The project-update endpoint (`PUT /api/projects/{PROJECT}`) reads no team field (traced: `routes/projects/updateProject.ts`) — a team key there 200s and changes nothing.

(source: `routes/teams.ts` at FOSSA `22fc86d76b` — `GET /api/teams` :98-169, `POST /api/teams` :176-219 reads `name` / `autoAddUsers` / `defaultRoleId` (+ `uniqueIdentifier`, read just past that range at :220 / :265 — see the Lookups note below), `PUT /api/teams/:id` :278, `GET /api/teams/:id` :294-310, `PUT /api/teams/:id/projects` :816-951. Live-observed 2026-09-16: create, `?teamId=` filter, the 403 on a push-only token; everything else traced, not observed.)

**Lookups — find a team, list its members.** These are the paginated routes (all three documented in the published spec); prefer them to the legacy list on large orgs:

```
GET /api/v2/teams             # ?search=&page=&pageSize= → { results: [team + teamMembersCount, teamProjectsCount, teamReleaseGroupsCount], page, pageSize, totalCount }
GET /api/v2/teams/{id}        # one team by numeric id + teamProjectsCount, teamReleaseGroupsCount, teamMembersCount, and an optional teamOIDCProvidersCount (counts only — no member or project lists)
GET /api/teams/{id}/members   # ?search=&page=&pageSize= → { results: [{ userId, roleId, username, email, isServiceAccount }], page, pageSize, totalCount }
```

- **Pagination** (these routes and `GET /api/v2/users` below): `page` is 1-indexed (default 1); `pageSize` defaults to 10 and is **clamped to 50** — asking for more is not an error, you just get 50. Loop pages until you've collected `totalCount`.
- `GET /api/v2/teams`: `search` is a case-insensitive substring match on the team **name only** (≤ 255 chars); results are ordered by id, and the three counts are always present (`0` when empty). **There is no filter on `uniqueIdentifier` or on any other field, and unknown query params are silently ignored** — `?uniqueIdentifier=<x>` returns the same `totalCount` as no filter at all, so a mistyped filter looks like a full list, never like an empty one.
- **Finding a team by your own external id**: every team carries a `uniqueIdentifier` (nullable text, unique within the org — a duplicate is a 400; set it in the `POST /api/teams` or `PUT /api/teams/{id}` body — the API accepts it even when the dashboard's unique-ID field is not enabled for the org), but no endpoint looks a team up by it: `?search=<uniqueIdentifier>` returns nothing (name-only), and `{id}` in `/api/teams/{id}` and `/api/v2/teams/{id}` is FOSSA's numeric id only — a non-numeric identifier there returns 400 `Invalid team ID specified in request.`; a numeric-looking one returns 404 `Team not found.` **unless that number is also the numeric id of a real team you can view — then you silently get that other team (HTTP 200)**. Never probe these routes with an external identifier. Either store FOSSA's numeric team `id` when you create the team (the create response is the team row), or build a `uniqueIdentifier → id` map and cache it across runs — paging `GET /api/v2/teams` costs ⌈teams / 50⌉ requests; for a one-shot backfill the legacy `GET /api/teams` returns every team in a single (large) response instead.
- **Trap — `teamId` filters take the numeric id, never the `uniqueIdentifier`.** The `teamId` param on `GET /api/v2/projects` (and `/minimal`) and on the v2 issues endpoints accepts integers (or `null`). Pass a unique identifier there and what comes back depends on the value **and on your token — and none of it tells you the identifier was wrong**: a non-numeric value → 400; a numeric-looking value that is not one of your teams → **HTTP 200 with an empty result** (`total: 0` / zero issue counts) when the token can view every team (for issues: every team or every project), but **403 `You are not permitted to view this team.`** when the token is scoped to specific teams; and a number that happens to be the id of a real team you may view → **that other team's projects and issues**. Resolve identifier → numeric `id` first, and treat neither a 200 nor a 403 as a statement about the identifier.
- `GET /api/teams/{id}/members` is the way to get a team's member **emails and roles** without listing the org's users. `search` is a case-insensitive substring match on `username` OR `email`; results are ordered by `userId`. `roleId` is the member's role on that team — map it to a name with `GET /api/roles` (`[{ id, name, scope, … }]`); orgs that have disabled the built-in team roles get those roles filtered out of that list, so a member who still holds one has a `roleId` that won't resolve.
- The legacy `GET /api/teams` has no pagination at all: every call returns every team the caller can view, each with every member's `{ userId, roleId }` inlined (`teamUsers` is `null`, not `[]`, on a team with no members), so its size and latency grow with the org. Its `teamProjectsCount` comes from a separate inner-join query merged in afterwards, which is why the key is missing (rather than `0`) on teams with no projects; the v2 list does not have that quirk.

(source: traced at FOSSA `fe046cc9039a` — `GET /api/v2/teams` `routes/teams.ts:1119-1130`, its query validator `shared/types/routes/teams.ts:150-152` (reads only `search`), `getTeams` `modules/TeamManager/index.ts:716-772` (`where.name` iLike :724-726, count subqueries :729-758, order :760); `GET /api/v2/teams/:id` `routes/teams.ts:355-432` (response type, optional OIDC count: `shared/types/routes/teams.ts:102-107`); `GET /api/teams/:id/members` `routes/teams.ts:435-474` + `getTeamMembers` `modules/TeamManager/index.ts:319-364`; pagination defaults and clamp `routes/common/pagination.ts:13-16, 58-68`; `uniqueIdentifier` — nullable text `models/team/index.ts:45-50`, unique index on org + identifier `migrations/20210122225158-teams-unique-id.js:12-15`, duplicate → 400 `modules/TeamManager/index.ts:96-104`, read on create `routes/teams.ts:220, 265`, on update `modules/TeamManager/index.ts:176, 194`; legacy list — unbounded `findAll` `routes/teams.ts:99-127`, inner-join project count :130-158 merged :165-171; `GET /api/roles` `routes/roles.ts:72-135` (built-in team roles filtered when the org disables them :126-133); path id parsing `routes/teams.ts:294-297, 356-358` (`Number(id)` falsy → 400); legacy `teamUsers` is a bare `json_agg` subquery `routes/teams.ts:103-110` (NULL over zero rows); `teamId` filter parsing — issues `routes/issuesV2/validators/general.ts:57-62` (zod: numbers or `null`) and `serverutil/validators.ts:6-29` (integers or `null`; non-integers → 400), projects `routes/projectsV2/helpers.ts:92-103`; `teamId` permission gate → 403 — projects `routes/projectsV2/index.ts:58-63, 164-169` via `userPermissionForTeams` (`modules/TeamManager/index.ts:43-57`: team-any View, or team View on every id), issues `routes/issuesV2/index.ts:160, 203, 253, 296, 347, 393, 479, 611, 660` (list, statuses, categories, types, package-managers, license-list, cwes, revisions) via `userCanViewTeamsForIssues` (`shared/permissions/helpers.ts:32-49`: project-any or team-any View, or team View on every id); `teamGroupIds` on create `routes/teams.ts:185-220`; create path sets `uniqueIdentifier` with no feature-flag check (`routes/teams.ts:176-270` consults only the team-groups flag), the unique-ID flag is read only by the dashboard's team modal (`app/components/settings/organization/teams/CreateEditTeamModal.tsx:97`). collision case: the path id and the `teamId` filters are plain numeric-id lookups (same ranges), so an identifier equal to a real team id resolves to that team — traced, not observed. OpenAPI: `docs/swagger/paths/teams/teams.v2.yaml`, `team.id.v2.yaml`, `teamMembers.yaml`, and `teams.yaml` (`createTeam`) + `team.id.yaml` (`updateTeam`), whose request bodies document `uniqueIdentifier`. Live-observed 2026-09-17 **with a token that can view every team** (so the 403 branch above is traced, not observed), on a team whose `uniqueIdentifier` was set to a numeric-looking string: `?uniqueIdentifier=` / `?uniqueId=` / `?unique_identifier=<x>` on `GET /api/v2/teams` and `?uniqueIdentifier=<x>` on legacy `GET /api/teams` all return the unfiltered list; `?search=<x>` → `totalCount: 0` while a name fragment finds the team (row carries `uniqueIdentifier`); `GET /api/v2/teams/<x>` and `GET /api/teams/<x>` → 404 "Team not found."; `GET /api/v2/projects?teamId=<x>` → `total: 0` and v2 issue counts `{active: 0, ignored: 0}` with HTTP 200, versus the real numeric id returning the team's projects and issues; a non-numeric `teamId` → 400 on both (`Invalid integer value for param 'teamId'` / a validation error); a non-numeric path id (`/api/v2/teams/<word>`, `/api/teams/<word>`) → 400 `Invalid team ID specified in request.`; legacy `GET /api/teams` returns `teamUsers: null` for a team with no members; the `GET /api/teams/{id}/members` response shape. Everything else traced, not observed.)

## Users

All three routes are documented in the published spec (the legacy list is marked deprecated there).

```
GET /api/v2/users      # ?search=&sort=&page=&pageSize= → { results: [user + teamsCount], page, pageSize, totalCount }
GET /api/users/{id}    # one user by numeric id, plus teamUsers: [{ roleId, team: { id, name } }]
GET /api/users         # ⚠ deprecated — paginates in memory; see below
```

- **v2 list**: pagination as for the team lookups above (1-indexed `page`; `pageSize` default 10, clamped to 50). `search` is a case-insensitive substring match across `username`, `email`, and `full_name` (≤ 255 chars). `sort` is one of `username_asc|desc`, `full_name_asc|desc`, `email_asc|desc`, `created_at_asc|desc`, `last_visit_asc|desc` (default: id ascending; any other value is a 400). Each result is the user's fields (`id`, `username`, `email`, `full_name`, `enabled`, `isServiceAccount`, `last_visit`, `createdAt`, …) plus `userRole: { roleId, role: { id, name, scope, … } }` (the org-level role; `null` when the user has none) and `teamsCount`. Results are limited to the users the caller is allowed to view.
- `GET /api/users/{id}` returns the same user fields plus `teamUsers` — the user's teams with the role held on each (limited to teams shared with the caller when the caller can't view all of the org's users).
- There is **no "users by ids" filter** on any of these. For a known id use `GET /api/users/{id}`; for a team's roster use `GET /api/teams/{id}/members` (above).
- **⚠ Don't use the legacy `GET /api/users` on a large org.** It is deprecated in favour of v2 and **paginates in memory**: every request loads ALL of the org's users from the database, then the team memberships of all of them, and only afterwards slices out the requested page (`count` default 100, `page` **zero-based**, bare-array response with no total). A small `count` therefore does not make it cheaper — the cost tracks the org's total user count, so on large orgs (e.g. SCIM-provisioned ones) it is slow however little you ask for. Use `GET /api/v2/users`, which paginates in the database, or the team-members endpoint instead.

(source: traced at FOSSA `fe046cc9039a`, nothing live-observed — `GET /api/v2/users` `routes/users/v2.ts:11-23`, `getUsers` `modules/UserManager/index.ts:89-176` (visibility scoping :102-117, search :119-127, database `limit`/`offset` :137-157, default order :15), sort values `routes/users/sorting.ts:3-9, 55-61`, query validator `routes/users/types.ts:59-64`, item shape `routes/users/types.ts:55-57` + `routes/users/helpers.ts:15-20, 33-77, 99-109` (`userRole` null-guard :55), `userRole` is an org-scope role `routes/users/index.ts:1647-1659`, invalid query → 400 `app.ts:374-377`; `GET /api/users/:id` `routes/users/index.ts:2096-2179` (`teamUsers` include :1792-1803, scoping :2118-2131); legacy `GET /api/users` `routes/users/index.ts:2181-2339` — `@deprecated` :2181-2183, load-everything comment :2222-2225, unbounded `findAll` :2261, all users' team memberships :2277-2285, zero-based `page` / default `count` 100 :2251-2259, in-memory `slice` :2328, bare array :2337. OpenAPI: `docs/swagger/paths/users/users.v2.yaml`, `users.id.yaml`, `users.yaml` (`deprecated: true`).)

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
