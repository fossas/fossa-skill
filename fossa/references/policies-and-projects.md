# Policies, projects, and release groups

## Policies

A policy is a set of rules (allow/flag/deny per license, plus security/quality rules) attached to projects. Types: `LICENSING`, `SECURITY`, `QUALITY`, `SBOM`.

```
GET  /api/policies                 # list all org policies (id, title, type, rules)
GET  /api/policies/{id}            # read one, including its rules
POST /api/policies                 # create — body { title, type, description?, defaultAction?, the four licensing flags?, template?, extendedPolicyId? }; what gets seeded: see below
PUT  /api/policies/{id}            # title, description, defaultAction + the four licensing flags; a "rules" array here is never read
POST /api/policies/{id}/rules      # APPEND one rule { type, licenseId } — 400 if that license already has a rule; see below
PUT  /api/policies/{id}/rules      # ⚠ REPLACES the whole rule set — body is a BARE ARRAY [{ type, licenseId, ... }]; anything omitted is deleted, and a { "rules": [...] } wrapper silently EMPTIES the policy (200)
DELETE /api/policies/{id}          # delete
```

- None of the policies endpoints are in the served API spec — `PUT /api/policies/{id}` carries `x-internal: true` (`docs/swagger/paths/policies/updatePolicy.yaml:2`), so the whole family is informal, dashboard-stable. Every policy/rules write except `POST /api/policies/import` needs a premium subscription (403 `User not permissioned for feature. Feature requires "premium" subscription access level.` otherwise; on-prem is exempt, `routes/helpers.ts:265-267, 299-300` — gates at `routes/policies/index.ts:217, 261, 323`; `routes/rules/index.ts:52, 72, 95, 152, 167, 185, 205`).
- **`PUT /api/policies/{id}` never persists rules.** Its body is `title`, `description`, `defaultAction` and the licensing flags `intelligentAutoIgnoreEnabled`, `onlyConcludedLicensesEnabled`, `unconcludedIssueScanningEnabled`, `multiLicenseConclusionsEnabled` (`routes/policies/index.ts:258-272`); a `rules` array is ignored — the existing rules stay exactly as they were and `latestVersion.rulesHash` does not change (live-observed 2026-09-10, PR #8 by asalminen). ⚠ `intelligentAutoIgnoreEnabled` is accepted but ignored (200, no change) whenever `onlyConcludedLicensesEnabled` is, or in the same request becomes, true (`modules/PolicyManager/licensingPolicyUpdates.ts:63-67, 79-92`; the spec says so, `updatePolicy.yaml:15`) — send them in separate requests and re-GET. Rules live on the sub-resource.
- **Rules sub-resource** (`routes/rules/index.ts`): `POST /api/policies/{id}/rules` appends ONE rule — `{ "type": "approved_license" | "flagged_license" | "denied_license", "licenseId": "<FOSSA license id — the SPDX id where one exists; GET the policy to see the exact form>" }` (`:49-68`). `addRule` merges it into the existing set and re-runs the whole-set checks (`models/policy/model.ts:397-406` → `modules/PolicyManager/index.ts:208-258`): the same license with the same action → 400 `Multiple rules with the same license ID and action were provided`; a different action → 400 `Conflicting rules: license "<id>" cannot be both <a> and <b>` (a contradiction the policy version already carried is grandfathered, `:216-258`); a normalized duplicate inside one request → 400 `Duplicate rules were provided` (`:87-92`). A licensing rule can also carry `linkingCondition` (`STATIC` | `DYNAMIC`), `depthCondition` (`DIRECT` | `DEEP`), `nameCondition` and `notes` (`models/licensingrule/index.ts:21-24`); the conditions are part of a rule's identity for versioning, but the whole-set check compares only `type` + `licenseId` (`sameTypeAndLicense`, `:210-215`), so the same license with the same action under two different conditions is rejected with the `Multiple rules…` 400 on every write path that runs these checks. A policy built from a licensing template already carries a rule for every catalogued license, so on those the append path only works for licenses the template lacks; change an existing rule with `PUT /api/policies/{id}/rules/{ruleId}` (`:164-181`), move licensing rules between columns with `PATCH /api/policies/{id}/rules` `{ "newRules": [...] }` (`:182-201`), or `DELETE /api/policies/{id}/rules/{ruleId}` (`:149-163`) then `POST`. `licenseId` is unvalidated `TEXT` (`models/licensingrule/index.ts:17-19`; the single-rule POST runs no validator), so a wrong id returns 200 and makes a rule that never matches — read the rule back. For an in-place bulk change use `POST /api/policies/{id}/rules/bulk` `{ "newRules": [...] }` (LICENSING only, `:69-91`) or `PUT /api/policies/{id}/rules` with the complete bare array. `GET /api/policies/{id}/export` → `POST /api/policies/import` (multipart `policyFile`, `routes/policies/index.ts:118-212`) does **not** edit a policy: it creates a brand-new LICENSING policy from the file (`:195-211`, `createFromFixture` with `type: LICENSING`), so projects would have to be re-attached — a clone / cross-org migration path — and it is FOSSA-internal super-admin only (`helpers.admin` = `req.user.super`, `routes/helpers.ts:182-190`; anyone else gets a bare 404, not a 403). Each distinct resulting rule set mints a new policy version (identical sets reuse one — `findOrCreatePolicyVersion` keys on the rules hash and the flags, `modules/PolicyManager/index.ts:469-486`), so never loop single-rule POSTs over a catalogue.
- **Creating**: `POST /api/policies` passes the body through to `createFromFixture`, whose pick is `title`, `type`, `description`, `defaultAction`, `intelligentAutoIgnoreEnabled`, `onlyConcludedLicensesEnabled`, `unconcludedIssueScanningEnabled`, `multiLicenseConclusionsEnabled` (`routes/policies/index.ts:214-256` → `models/policy/model.ts:58-73`; a `rules` array in the create body is ignored), plus `template` and `extendedPolicyId`. SECURITY / QUALITY / SBOM policies are always seeded from the type's default template (`security_default` / `quality_default` / `sbom_default`, `models/policy/model.ts:103-115`); a LICENSING policy is empty unless you pass `template` (a template file name such as `standard_bundle`, `hosted_service`, `single_binary`, each a full rule set over the license catalogue, `:116-128`) or `extendedPolicyId`, which copies only the source policy's **rules** — `title`, `description`, `defaultAction` and the flags come from your own create body (`clonePolicy` picks them from the request, `:131-153`), and `multiLicenseConclusionsEnabled` is absent from that pick, so on the clone path it always lands at the default. `defaultAction` defaults to `APPROVE` when omitted (`modules/PolicyManager/index.ts:472`) — pass it at create instead of a follow-up `PUT`, which re-scans every project on the policy.
- The common flow is _resolve name → id, then act_: list policies, match on `title`, use the `id`. (FOSSA's own CLI does exactly this when creating release groups.)
- **Policy edits are org-visible and affect issue scans on every project using the policy.** Read the policy first, show the user what will change, and prefer additive rule changes (`POST .../rules`, one license at a time) over `PUT .../rules`, which replaces the whole set — never send it a rules array you haven't fully read.
- To change which policy a _project_ uses, update the project (below) rather than editing the policy.

(source: FOSSA develop `5a248a1963`, 2026-10-28 — `routes/policies/index.ts` list :56, read :98, export :118-173, import :175-212 (`helpers.admin`, no subscription gate), create :214-256, update :258-321, delete :323; `routes/rules/index.ts` POST :49-68, bulk :69-91, PUT replace :92-107, DELETE one :149-163, PUT one :164-181, PATCH :182-201, DELETE many :202-221; dup/conflict checks `modules/PolicyManager/index.ts:208-258`; `models/policy/model.ts:58-73` create pick, `:103-128` templates, `:131-153` clone, `:367-432` replace/add; `modules/PolicyManager/licensingPolicyUpdates.ts:63-140` flag updates. Live-observed 2026-09-10 by asalminen (PR #8): the `PUT /api/policies/{id}` rules no-op and the singular project policy fields round-trip; everything else traced, not observed.)

## Projects

```
GET /api/projects?count=100&page=1     # list org projects (informal; the documented list is GET /api/v2/projects)
GET /api/projects/{PROJECT}            # one project — settings, default branch, policy ids
PUT /api/projects/{PROJECT}            # update settings (title, default branch, the four policy-id fields — see below…)
PUT /api/v2/projects/policy?policyId={id}&locators[]=…   # documented bulk attach (updateProjectsPolicies); infers the field from the policy's type — LICENSING/SECURITY/QUALITY only (an SBOM policy has no field and does not fail cleanly); returns { locator: error } per failure. ⚠ bare locators=all applies it to EVERY project the caller can see (other filters ignored); omit locators to apply by filter
GET /api/projects/{PROJECT}/revisions  # list scanned revisions (newest first)
```

`{PROJECT}` = URL-encoded **project** locator (no `$revision`), e.g. `custom+1234/github.com/acme/api-server`.

- **Policy attachment fields are singular and typed** — `policyId` (LICENSING), `securityPolicyId`, `qualityPolicyId`, `sbomPolicyId`; there is no `policies` array (allowlist `routes/projects/updateProject.ts:55-111`; found by asalminen, PR #8). They are permission-gated per type: without Set-policy permission for that type the key is silently dropped and the `PUT` still 200s (`specialPermissionFields` `:349-374`, the `_.omit` / `_.pick` at `:385-397`), so re-`GET` the project and compare the id instead of trusting the 200. The documented bulk route `PUT /api/v2/projects/policy` (`docs/swagger/paths/projectsV2/policy.yaml`; `routes/projectsV2/index.ts:212-225` → `bulkApplyPolicyToProjects`, `modules/PolicyManager/index.ts:839`) covers LICENSING / SECURITY / QUALITY (`policyTypeToFieldMap` `:816-820` has no SBOM entry, so an SBOM policy there resolves to an `undefined` column, not a clean 400), so `sbomPolicyId` goes through the per-project `PUT`. `locators` is either an array or the bare literal `all` (`routes/projectsV2/validators.ts:10-13`): bare `locators=all` applies the policy to **every project the caller can see in the org** and skips the other query filters entirely, while `locators[]=all` parses as an array and is treated as one literal locator named "all" (does nothing useful); to apply by filter, omit `locators` and pass filters — that path requires at least one or 400s `No filter criteria for projects was provided` (`getLocatorsFromQuery`, `modules/ProjectManagerV2/index.ts:530-543`).
- **v2 list filters** (flat params): `title` (case-insensitive substring), `labels[]` (label NAMES, case-insensitive, any-match), `type[]` (container|archive|provided|autobuild|sbom|binary), `teamId` (id, array, or literal `null` = unassigned), `locators[]` (exact), `latestScan`/`lastRevisionWithin` (days), `sort` (`title_asc/desc`, `latest-scan_asc/desc`, `issues-total_asc/desc`, …; default latest-scan_desc). Response `{projects, total}` — `total` ignores pagination. `count` default 10, clamped [1, 1000]. There is NO policy filter on the list.
- v1 `GET /api/projects` differs entirely: `fetcher=` prefix filter, `offset` (not page), default count 5000, bare-array response with the total only in the `content-range` header.
- Find a project from a human name: v2 `title=` filter, confirm with the user when more than one matches.
- The revisions response is **grouped by branch**: `{ "branch": { "master": [ { "locator": "custom+…$…", "revision_timestamp": …, "resolved": … } ] } }`. Take the newest entry of the branch you care about — its `locator` is the revision locator you need for issues/reports.
- `PUT /api/projects/{PROJECT}` can only _clear_ a project's public-report id: a non-empty `bom_public_id` in the body is silently dropped, `""`/`null` stores NULL (`routes/projects/updateProject.ts:331-340`, since FOSSA `de507a5b4e`); the id is generated server-side only. An empty `title` or an empty `default_branch` (when one is stored) is rejected with 400 (`routes/projects/utils.ts:27-36`).
- Update revision metadata (link, author): `PATCH /api/revisions/{REV}` (documented). Note there is no useful bare GET on that exact path in the current API docs; for package metadata use the endpoints in `packages.md`.

(source: FOSSA develop `5a248a1963`, 2026-10-28 — `routes/projects/updateProject.ts` allowlist :55-111, `bom_public_id` strip :331-340, special-permission fields :349-374, omit/pick :385-397; `routes/projectsV2/index.ts:212-225`; `modules/PolicyManager/index.ts:816-820`, `:839`. Live-observed 2026-09-10 by asalminen: the singular policy fields round-trip; everything else traced.)

## Teams

Teams scope projects for filtering and RBAC. **`fossa analyze -T/--team <name>` does not create the team — an unknown name FAILS the upload.** The upload handler always throws 404 `specified team '<name>' not found` (`modules/customBuildUploadHandler.ts:87-93`); on orgs with preflight checks the CLI fails earlier with the same error via `GET /api/cli/custom_build_permissions` (`routes/cli/permissions.ts:50-62`; `fossa-cli src/App/Fossa/PreflightChecks.hs:74-79`). Nothing lands. Create first, then tag:

```
GET  /api/teams                # [{ id, name, organizationId, defaultRoleId, autoAddUsers, teamUsers, teamProjectsCount, teamReleaseGroupsCount, … }]
                               #   (deprecated in favour of the paginated GET /api/v2/teams — routes/teams.ts:139-141)
POST /api/teams                # { "name", "autoAddUsers": false, "defaultRoleId", "uniqueIdentifier"?, "teamGroupIds"? }   (informal — the dashboard's route; optional keys: see the team-groups bullet below)
GET  /api/teams/{id}           # one team, plus teamProjects: [{ projectId, … }], teamUsers: [{ userId, roleId }], teamReleaseGroups
PUT  /api/teams/{id}           # rename / settings
PUT  /api/teams/{id}/projects  # { "action": "add" | "remove" | "replace", "projects": ["<project locator>", …] | "all" }   ⚠ see below
```

- `defaultRoleId` is the org's team role id — copy it from an existing team in the list or `GET /api/roles` (a "Team Viewer"-style role); ids differ per org.
- Creating is permission-gated (`routes/teams.ts:223` → 403 without the team-create permission; a push-only token was observed to 403).
- `uniqueIdentifier` is an optional stable external id (`routes/teams.ts:264`, `:309`). `teamGroupIds` is gated on the `teamGroups` feature flag ("Team Groups", a customer flag; `:229-230`): with the flag **off** the key is silently ignored and the team is still created with a 200 (else branch `:303-318`, `res.json(team)` at `:317`); with it **on**, a caller holding the org-wide `TeamProjectAny`/`Add` permission always clears the permission check; a team-scoped caller clears it only when the request includes **every** team group they hold add permission on — the guard compares the caller's whole add-permitted set against the ids sent, not the other way round (`:233-245`, throw `You are not permitted to add teams to these team groups.` at `:244`), and an empty `teamGroupIds` list 403s as well; each requested group must then be visible to the caller or the request 404s `Team group not found` (`:247-257`). Both throws precede `createTeam` (`:260`), so a 403 or 404 here also means no team was created.
- **Assigning existing projects: `PUT /api/teams/{id}/projects` and ALWAYS send `"action": "add"`.** Omitting `action` (or sending `"replace"`) **replaces the team's whole project set** — every project not in your list is unassigned (`deleteAllTeamProjects` for the team, then `insertTeamProjects`: `modules/RoleManager/teams.ts:366-392`; body / permission / execution switches at `routes/teams.ts:862-866, 903-919, 945-968`). `add` 403s if any locator is outside the org or the caller lacks Edit on it; the replace path needs add AND remove permission. `"remove"` is the inverse. Read-back: `{ id, projects: [locators] }`; unknown team = bare 404. New uploads take `-T "<name>"`. List a team's projects with `GET /api/v2/projects?teamId={id}` (`teamId=null` = unassigned).
- The project-update endpoint (`PUT /api/projects/{PROJECT}`) reads no team field (traced: `routes/projects/updateProject.ts`) — a team key there 200s and changes nothing.

(source: `routes/teams.ts` at FOSSA develop `5a248a1963`, re-pinned 2026-10-28 — the earlier `22fc86d76b` pin was a prototype-branch snapshot, not develop — `GET /api/teams` :142-219, `POST /api/teams` :220-321 reads `name` / `autoAddUsers` / `defaultRoleId` / `uniqueIdentifier` (:261-264, :306-309; `teamGroupIds` branch :229-302, flag-gated at :229-230 on `teamGroups`, 403-before-create at :244, flagless else branch :303-318), `PUT /api/teams/:id` :322-337, `GET /api/teams/:id` :338-395, `PUT /api/teams/:id/projects` :850-993. Live-observed 2026-09-16: create, `?teamId=` filter, the 403 on a push-only token; everything else traced, not observed.)

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
