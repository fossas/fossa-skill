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
- `PUT /api/projects/{PROJECT}` can only _clear_ a project's public-report id: a non-empty `bom_public_id` in the body is silently dropped, `""`/`null` stores NULL (`routes/projects/updateProject.ts:343-349`, since FOSSA `de507a5b4e`); the id is generated server-side only. An empty `title` or an empty `default_branch` (when one is stored) is rejected with 400 (`routes/projects/utils.ts:27-36`).
- Update revision metadata (link, author): `PATCH /api/revisions/{REV}` (documented). Note there is no useful bare GET on that exact path in the current API docs; for package metadata use the endpoints in `packages.md`.

## Teams

Teams scope projects for filtering and RBAC. **`fossa analyze -T/--team <name>` does not create the team — an unknown name FAILS the upload.** The upload handler always throws 404 `specified team '<name>' not found` (`modules/customBuildUploadHandler.ts:87-93`); on orgs with preflight checks the CLI fails earlier with the same error via `GET /api/cli/custom_build_permissions` (`routes/cli/permissions.ts:50-62`; `fossa-cli src/App/Fossa/PreflightChecks.hs:74-79`). Nothing lands. Create first, then tag:

```
GET  /api/teams                # [{ id, name, organizationId, defaultRoleId, autoAddUsers, teamUsers, teamProjectsCount, teamReleaseGroupsCount, … }]
                               #   (deprecated in favour of the paginated GET /api/v2/teams — routes/teams.ts:139-141)
                               #   teamProjectsCount is absent (not 0) on teams with no projects; unpaginated — see Lookups below
POST /api/teams                # { "name", "autoAddUsers": false, "defaultRoleId", "uniqueIdentifier"?, "teamGroupIds"? }   (documented: createTeam in docs/swagger/paths/teams/teams.yaml; optional keys: see the team-groups bullet below)
GET  /api/teams/{id}           # one team, plus teamProjects: [{ projectId, … }], teamUsers: [{ userId, roleId }], teamReleaseGroups
PUT  /api/teams/{id}           # rename / settings (name, autoAddUsers, defaultRoleId, uniqueIdentifier)   (documented)
PUT  /api/teams/{id}/projects  # { "action": "add" | "remove" | "replace", "projects": ["<project locator>", …] | "all" }   ⚠ see below
```

- `defaultRoleId` is the org's team role id — copy it from an existing team in the list or `GET /api/roles` (a "Team Viewer"-style role); ids differ per org.
- Creating is permission-gated (`routes/teams.ts:223` → 403 without the team-create permission; a push-only token was observed to 403).
- `uniqueIdentifier` is an optional stable external id (`routes/teams.ts:264`, `:309`). `teamGroupIds` is gated on the `teamGroups` feature flag ("Team Groups", a customer flag; `:229-230`): with the flag **off** the key is silently ignored and the team is still created with a 200 (else branch `:303-318`, `res.json(team)` at `:317`); with it **on**, a caller holding the org-wide `TeamProjectAny`/`Add` permission always clears the permission check; a team-scoped caller clears it only when the request includes **every** team group they hold add permission on — the guard compares the caller's whole add-permitted set against the ids sent, not the other way round (`:233-245`, throw `You are not permitted to add teams to these team groups.` at `:244`), and an empty `teamGroupIds` list 403s as well; each requested group must then be visible to the caller or the request 404s `Team group not found` (`:247-257`). Both throws precede `createTeam` (`:260`), so a 403 or 404 here also means no team was created.
- **Assigning existing projects: `PUT /api/teams/{id}/projects` and ALWAYS send `"action": "add"`.** Omitting `action` (or sending `"replace"`) **replaces the team's whole project set** — every project not in your list is unassigned (`deleteAllTeamProjects` for the team, then `insertTeamProjects`: `modules/RoleManager/teams.ts:366-392`; body / permission / execution switches at `routes/teams.ts:862-866, 903-919, 945-968`). `add` 403s if any locator is outside the org or the caller lacks Edit on it; the replace path needs add AND remove permission. `"remove"` is the inverse. Read-back: `{ id, projects: [locators] }`; unknown team = bare 404. New uploads take `-T "<name>"`. List a team's projects with `GET /api/v2/projects?teamId={id}` (`teamId=null` = unassigned).
- The project-update endpoint (`PUT /api/projects/{PROJECT}`) reads no team field (traced: `routes/projects/updateProject.ts`) — a team key there 200s and changes nothing.

(source: `routes/teams.ts` at FOSSA develop `5a248a1963`, re-pinned 2026-10-28 — the earlier `22fc86d76b` pin was a prototype-branch snapshot, not develop — `GET /api/teams` :142-219, `POST /api/teams` :220-321 reads `name` / `autoAddUsers` / `defaultRoleId` / `uniqueIdentifier` (:261-264, :306-309; `teamGroupIds` branch :229-302, flag-gated at :229-230 on `teamGroups`, 403-before-create at :244, flagless else branch :303-318), `PUT /api/teams/:id` :322-337, `GET /api/teams/:id` :338-395, `PUT /api/teams/:id/projects` :850-993. Live-observed 2026-09-16: create, `?teamId=` filter, the 403 on a push-only token; everything else traced, not observed.)

**Lookups — find a team, list its members.** These are the paginated routes (all three documented in the published spec); prefer them to the legacy list on large orgs:

```
GET /api/v2/teams             # ?search=&page=&pageSize= → { results: [team + teamMembersCount, teamProjectsCount, teamReleaseGroupsCount], page, pageSize, totalCount }
GET /api/v2/teams/{id}        # one team by numeric id + teamProjectsCount, teamReleaseGroupsCount, teamMembersCount, and an optional teamOIDCProvidersCount (counts only — no member or project lists); ?idType=uniqueIdentifier makes {id} your own unique identifier (since 4.34.110)
GET /api/teams/{id}/members   # ?search=&page=&pageSize= → { results: [{ userId, roleId, username, email, isServiceAccount }], page, pageSize, totalCount }; ?idType=uniqueIdentifier accepted here too
```

- **Pagination** (these routes and `GET /api/v2/users` below): `page` is 1-indexed (default 1); `pageSize` defaults to 10 and is **clamped to 50** — asking for more is not an error, you just get 50. Loop pages until you've collected `totalCount`.
- `GET /api/v2/teams`: `search` is a case-insensitive substring match on the team **name only** (≤ 255 chars); results are ordered by id, and the three counts are always present (`0` when empty). **There is no filter on `uniqueIdentifier` or on any other field, and unknown query params are silently ignored** — `?uniqueIdentifier=<x>` returns the same `totalCount` as no filter at all, so a mistyped filter looks like a full list, never like an empty one.
- **Finding a team by your own external id**: every team carries a `uniqueIdentifier` (nullable text, unique within the org — a duplicate is a 400; set it in the `POST /api/teams` or `PUT /api/teams/{id}` body — the API accepts it even when the dashboard's unique-ID field is not enabled for the org). Since FOSSA `c418f227cb` (2026-09-18, first tag 4.34.110) the GET routes resolve it directly: `GET /api/v2/teams/{uniqueIdentifier}?idType=uniqueIdentifier` and `GET /api/teams/{uniqueIdentifier}/members?idType=uniqueIdentifier` (both **documented**: `docs/swagger/paths/teams/team.id.v2.yaml`, `teamMembers.yaml`), plus the legacy `GET /api/teams/{uniqueIdentifier}?idType=uniqueIdentifier` (works, absent from its spec). The lookup is scoped to your organization (`routes/teams.ts:106-116`); a 404 `Team not found.` means either no team in your org carries the identifier (`:113-115`) or your token cannot view the one that does (`:401-404` on the v2 route, `:341-344` on the legacy one) — the members route returns 403 `You do not have permission to view this team.` for that case instead (`:496-499`); any `idType` other than `id` or `uniqueIdentifier` is a 400 `Invalid idType specified in request.` (`:119-121`). The spec notes unique identifiers exist only on organizations with the "Team Unique ID" feature flag. There is still **no list filter** on it — `GET /api/v2/teams?search=` is name-only and unknown query params are ignored (above). **Without `idType`, `{id}` is FOSSA's numeric id only** (`:123-126`, `Number.isSafeInteger` and `> 0`): a non-numeric identifier returns 400 `Invalid team ID specified in request.`, a numeric-looking one returns 404 `Team not found.` **unless that number is also the numeric id of a real team you can view — then you silently get that other team (HTTP 200)**. So never send an external identifier down the default path: add `idType=uniqueIdentifier`, or store FOSSA's numeric team `id` when you create the team (the create response is the team row). The `PUT` routes (`/api/teams/{id}`, `/api/teams/{id}/projects`) take the numeric id only.
- **Trap — `teamId` filters take the numeric id, never the `uniqueIdentifier`.** The `teamId` param on `GET /api/v2/projects` (and `/minimal`) and on the v2 issues endpoints accepts integers (or `null`). Pass a unique identifier there and what comes back depends on the value **and on your token — and none of it tells you the identifier was wrong**: a non-numeric value → 400; a numeric-looking value that is not one of your teams → **HTTP 200 with an empty result** (`total: 0` / zero issue counts) when the token can view every team (for issues: every team or every project), but **403 `You are not permitted to view this team.`** when the token is scoped to specific teams; and a number that happens to be the id of a real team you may view → **that other team's projects and issues**. These filters have no `idType`; resolve the identifier through the team routes above first, and treat neither a 200 nor a 403 as a statement about the identifier. On a **free-tier** organization the v2 issues `teamId` filter is dropped before validation (`routes/issuesV2/index.ts:176-179`, `:811`), so a 200 there is the org-wide issue set even for a valid numeric id; the projects filter has no such gate.
- `GET /api/teams/{id}/members` is the way to get a team's member **emails and roles** without listing the org's users. `search` is a case-insensitive substring match on `username` OR `email`; results are ordered by `userId`. `roleId` is the member's role on that team — map it to a name with `GET /api/roles` (`[{ id, name, scope, … }]`); orgs that have disabled the built-in team roles get those roles filtered out of that list, so a member who still holds one has a `roleId` that won't resolve.
- The legacy `GET /api/teams` has no pagination at all: every call returns every team the caller can view, each with every member's `{ userId, roleId }` inlined (`teamUsers` is `null`, not `[]`, on a team with no members), so its size and latency grow with the org. Its `teamProjectsCount` comes from a separate inner-join query merged in afterwards, which is why the key is missing (rather than `0`) on teams with no projects; the v2 list does not have that quirk. Enumerating every team through the v2 list costs ⌈teams / 50⌉ requests, so for a one-shot full dump the legacy call is still cheaper; for everything else prefer the paginated routes.

(source: traced at FOSSA develop `5a248a1963` — anchors re-pinned by content on 2026-10-28 from `fe046cc9039a`, a prototype-branch snapshot, and the identifier lookup re-traced after `c418f227cb` — `GET /api/v2/teams` `routes/teams.ts:1154-1165`, its query validator `shared/types/routes/teams.ts:164-166` (reads only `search`), `getTeams` `modules/TeamManager/index.ts:719-775` (`where.name` iLike :727-729, count subqueries :732-761, order :763); `GET /api/v2/teams/:id` `routes/teams.ts:396-473` (response type, optional OIDC count: `shared/types/routes/teams.ts:116-121`); `GET /api/teams/:id/members` `routes/teams.ts:476-511` + `getTeamMembers` `modules/TeamManager/index.ts:322-367`; pagination defaults and clamp `routes/common/pagination.ts:13-16, 58-68`; `uniqueIdentifier` — nullable text `models/team/index.ts:45-50`, unique index on org + identifier `migrations/20210122225158-teams-unique-id.js:12-15`, duplicate → 400 `modules/TeamManager/index.ts:97-105`, read on create `routes/teams.ts:264, 309`, on update `modules/TeamManager/index.ts:177, 195`; legacy list — unbounded `findAll` `routes/teams.ts:143-171`, inner-join project count :174-202 merged :209-215; `GET /api/roles` `routes/roles.ts:72-137` (built-in team roles filtered when the org disables them `:128-133`); path id parsing `resolveTeamId` `routes/teams.ts:106-125` (`idType=uniqueIdentifier` lookup :107-116 → 404 :113-115; any other `idType` → 400 :119-121; default numeric parse `Number.isSafeInteger` / `> 0` → 400 :123-126), called from `GET /api/teams/:id` :339, `GET /api/v2/teams/:id` :399 and the members route :488; `TeamIdQuery` `shared/types/routes/teams.ts:43`; legacy `teamUsers` is a bare `json_agg` subquery `routes/teams.ts:147-154` (NULL over zero rows); `teamId` filter parsing — issues `routes/issuesV2/validators/general.ts:61-66` (zod: numbers or `null`) and `serverutil/validators.ts:6-29` (integers or `null`; non-integers → 400), projects `routes/projectsV2/helpers.ts:92-103`; `teamId` permission gate → 403 — projects `routes/projectsV2/index.ts:58-63, 164-169` via `userPermissionForTeams` (`modules/TeamManager/index.ts:44-58`: team-any View, or team View on every id), issues `routes/issuesV2/index.ts:181, 224, 272, 313, 364, 410, 508, 675, 727` (list, statuses, categories, types, package-managers, license-list, cwes, revisions) via `userCanViewTeamsForIssues` (`shared/permissions/helpers.ts:32-49`: project-any or team-any View, or team View on every id); `teamGroupIds` on create `routes/teams.ts:229-264`; create path sets `uniqueIdentifier` with no feature-flag check (`routes/teams.ts:220-320` consults only the team-groups flag), the unique-ID flag is read only by the dashboard's team modal (`app/components/settings/organization/teams/CreateEditTeamModal.tsx:97`). collision case: without `idType` the path id and the `teamId` filters are plain numeric-id lookups, so an identifier equal to a real team id resolves to that team — traced, not observed. OpenAPI: `docs/swagger/paths/teams/teams.v2.yaml`, `team.id.v2.yaml`, `teamMembers.yaml`, and `teams.yaml` (`createTeam`) + `team.id.yaml` (`updateTeam`), whose request bodies document `uniqueIdentifier`. Live-observed 2026-09-17 **with a token that can view every team** (so the 403 branch above is traced, not observed), **before `c418f227cb` added `idType`** (so the `idType=uniqueIdentifier` behaviour is traced, not observed), on a team whose `uniqueIdentifier` was set to a numeric-looking string: `?uniqueIdentifier=` / `?uniqueId=` / `?unique_identifier=<x>` on `GET /api/v2/teams` and `?uniqueIdentifier=<x>` on legacy `GET /api/teams` all return the unfiltered list; `?search=<x>` → `totalCount: 0` while a name fragment finds the team (row carries `uniqueIdentifier`); `GET /api/v2/teams/<x>` and `GET /api/teams/<x>` → 404 "Team not found."; `GET /api/v2/projects?teamId=<x>` → `total: 0` and v2 issue counts `{active: 0, ignored: 0}` with HTTP 200, versus the real numeric id returning the team's projects and issues; a non-numeric `teamId` → 400 on both (`Invalid integer value for param 'teamId'` / a validation error); a non-numeric path id (`/api/v2/teams/<word>`, `/api/teams/<word>`) → 400 `Invalid team ID specified in request.`; legacy `GET /api/teams` returns `teamUsers: null` for a team with no members; the `GET /api/teams/{id}/members` response shape. Everything else traced, not observed.)

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

(source: traced at FOSSA develop `5a248a1963` (re-pinned by content 2026-10-28 from `fe046cc9039a`), nothing live-observed — `GET /api/v2/users` `routes/users/v2.ts:11-23`, `getUsers` `modules/UserManager/index.ts:89-176` (visibility scoping :102-117, search :119-127, database `limit`/`offset` :137-157, default order :15), sort values `routes/users/sorting.ts:3-9, 55-61`, query validator `routes/users/types.ts:59-64`, item shape `routes/users/types.ts:55-57` + `routes/users/helpers.ts:15-20, 33-77, 99-109` (`userRole` null-guard :55), `userRole` is an org-scope role `routes/users/index.ts:1637-1649`, invalid query → 400 `routes/middleware/errorHandler.ts:25`; `GET /api/users/:id` `routes/users/index.ts:2090-2173` (`teamUsers` include :1782-1793, scoping :2112-2125); legacy `GET /api/users` `routes/users/index.ts:2175-2333` — `@deprecated` :2175-2177, load-everything comment :2216-2219, unbounded `findAll` :2255, all users' team memberships :2271-2279, zero-based `page` / default `count` 100 :2245-2253, in-memory `slice` :2322, bare array :2331. OpenAPI: `docs/swagger/paths/users/users.v2.yaml`, `users.id.yaml`, `users.yaml` (`deprecated: true`).)

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

Poll until `SUCCEEDED`, then download from `url` (a signed link minted on each poll — `routes/reports.ts:86-134`). Release-group reports cover _all_ projects in the release — the right artifact when a customer ships a product composed of many scanned components. Formats on this v1 route are `HTML, MD, PDF, CSV, TXT, SPDX, SPDX_JSON, CYCLONEDX_JSON, CYCLONEDX_XML` (no `JSON`, no `SPDX3_JSON` — `routes/projectGroups.ts:1483-1491`). Two queue variants (both **documented**, since 2026-10-14, FOSSA `87ac5bc981`): `delivery=download` (`email` by default) stores the report instead of emailing it and the response's `reportId` is then fetchable at `https://app.fossa.com/attribution/{reportId}?download=true` (outside `/api`; 302 to a signed URL — details and the not-ready behaviour in `reports.md`); it cannot be combined with `isPublishing`. The v1 POST and the v2 `GET /api/v2/project_group/{groupId}/release/{releaseId}/attribution/{FORMAT}` share the handler (`routes/projectGroups/reportsV2.ts:203, 434-453`); on v2, `preview=true` or `download=true` renders synchronously instead of queueing. ⚠ **The v2 route's queued `taskId` is the job token (a UUID — `reportsV2.ts:453`), not v1's numeric task id (`legacyIntegerTaskId`, `routes/projectGroups.ts:1531`)**: poll it with `GET /api/jobs/status?jobs[]={taskId}` (see `reports.md`), because `GET /api/project_group/attribution/{taskId}` runs `Number()` on the id and 404s `Invalid task ID` for a UUID (`routes/reports.ts:91-93`). Root project components appear in these reports only with `includeFOSSADependencies=true`, and carry their own licenses only with `includeProjectLicense` / `includeLicenseScan` (see `reports.md`, CORE-7693; `routes/projectGroups/reportsV2.ts:96-110`).
