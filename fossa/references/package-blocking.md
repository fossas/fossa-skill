# Package Index and blocking packages

The Package Index ("Package Observability") is the org-wide view of every package in use — and the surface for **blocking** packages or versions so their use raises issues.

**What a block really is**: an org-scoped `blacklisted_dependency` rule written onto **quality policies**. Understanding that explains everything downstream: where it shows up, when it takes effect, and how to undo it.

Gating: the whole family needs the Package Index entitlement (403 without it); block writes additionally need quality policies enabled.

## Reading the index — documented ("Package Observability")

```
GET /api/packages?count=50&page=1          # paginated {data:[{locator,title,numberOfProjects,blockedVersionCount}],count}
GET /api/packages/package-summary          # {count, lastCacheDate}
GET /api/packages/{url-encoded package locator}            # one package's metadata
GET /api/packages/{package}/versions       # per-version blockedProjectCount, vulnSummary, licenses
GET /api/packages/{package}/versions/{version}/projects
GET /api/packages/{package}/versions/{version}/vulnerabilities
```

- Package locators are **version-less** (`npm+lodash`), URL-encoded in paths.
- Filters on the list: `packageName` (partial), `depth[]` (direct|transitive), `labels[]`, `projectName`, `sources[]`, `visibility[]`, `blockTypes[]` (has_blocked_packages|no_blocked_packages), `cve`, `cwes[]`, `fixTypes[]`, `severities[]`, `teamIds[]`, `locators[]`, `sort` (match|alphabetical|usage). Page cap 50.
- **The index is a cache** — check `lastCacheDate` before treating counts as current (blocked counts, however, are computed live from the rules).

## Blocking a package — informal (what the UI calls)

```
POST /api/packages/{url-encoded package locator}/rules
```

```json
{ "policyIds": [12345], "versions": "ALL" }
```

- `versions`: `"ALL"` (one all-versions rule; replaces any single-version rules for that package) or `["4.17.20", "4.17.21"]` (one rule per version; **additive and idempotent**).
- `policyIds` must be **your org's QUALITY policy ids** (resolve via `GET /api/policies`, filter `type == "QUALITY"`). Pass only your own policy ids.
- Each write creates a new policy version (audit-logged).

## What happens after a block

1. **Package Index counts update immediately** (computed live from rules).
2. **Issues arrive on the next scan, not instantly** — a policy edit does not trigger rescans; each revision picks up the `blacklisted_dependency` quality issue on its next build/issue-scan. Don't report "no issue appeared" as a failed block — check again after the project next scans.
3. The rule bites every project whose **effective** quality policy carries it (project's quality policy, else the org default) with quality scanning enabled.
4. Once the issue exists, `fossa test` fails the revision like any other issue — that's the CI gate.

## Unblocking

There is no unblock endpoint in the packages namespace — remove the rule from the quality policy:

```
DELETE /api/policies/{policyId}/rules
```

with body `{"ruleIds": [ ... ]}` — find the rule ids by reading the policy (`GET /api/policies/{id}`) and matching `blacklisted_dependency` rules for your package locator.
