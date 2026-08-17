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

- Find a project when the user gives you a human name: list projects and match on `title` (or locator substring). Confirm with the user when more than one matches.
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
