# Correcting licenses in FOSSA

FOSSA has **three distinct mechanisms** for fixing license data. Picking the wrong one is the most common failure in this workflow — they have different scopes, different permissions, and different effects on issues.

| Mechanism                   | Scope                                      | Clears `unlicensed_dependency` issues? | Permission                                        |
| --------------------------- | ------------------------------------------ | -------------------------------------- | ------------------------------------------------- |
| **Project correction**      | one package, within one project            | **Yes** (with `parentRevisionLocator`) | project Edit                                      |
| **License conclusion**      | one package revision, org-wide (or global) | **No** (see below)                     | broad project-edit rights (org admin in practice) |
| **User-defined dependency** | replaces an unresolvable dep entirely      | Yes (old dep gets ignored)             | project Edit                                      |

## 1. Project correction (the UI "Edit" modal mechanism)

Corrects the license (and optionally copyright, title, URL, text) of a dependency **as seen by one of your projects**. This is what the FOSSA web UI does when you edit a dependency's license, and it is the reliable way to both fix the data _and_ clear licensing issues.

```
PUT /api/projects/{projectLocator}/correction      # informal (what the UI calls); not in the published spec
```

- `{projectLocator}` is the dependency's locator **without** the `$revision` part, URL-encoded. For `mvn+com.example:widget$1.2.3` use `mvn%2Bcom.example%3Awidget`.
- Body:

```json
{
  "licenses": [
    [
      {
        "licenseId": "MIT",
        "copyright": "Copyright (c) 2020 Example Authors",
        "url": "https://github.com/example/widget/blob/main/LICENSE",
        "ignored": false
      }
    ]
  ],
  "parentRevisionLocator": "custom+1234/my-project$my-revision"
}
```

- `licenses` is an **array of arrays** (license groups; deps with multiple licenses get one entry per license).
- `parentRevisionLocator` = the locator of **your project revision** that imports this dependency. Including it queues an issue rescan of that revision — this is how existing licensing issues clear **without re-running a full scan**. Omit it and the data updates but stale issues linger until the next scan.
- **Trap — the `licenses` array replaces the whole corrected set.** There is no partial merge: whatever array you send becomes the correction. And a _first-time_ write that omits `licenses` creates an **empty** correction that hides all of the dependency's detected licenses. Always send the complete `licenses` array you want to end up with.

Verify the write (always read back):

```bash
curl -s -H "Authorization: Bearer $FOSSA_API_KEY" \
  "https://app.fossa.com/api/revisions/{url-encoded-full-locator}" \
  | jq '.project.projectCorrection.correctedLicenses'
```

Issue clearance after a correction is **asynchronous** — the rescan runs on a queue. Observed latency in production: roughly 45–70 minutes. Poll the issues endpoint (see `scans-and-issues.md`) rather than assuming failure.

## 2. License conclusion (org-wide assertion)

Asserts a concluded license for a package revision across your whole organization — the SPDX "concluded license" concept. Good for bulk cleanup of packages FOSSA resolved but has no license data for (e.g. internal rebuilds, packages missing from public metadata).

```
PUT /api/license-conclusions/conclude      # documented in the published spec
PUT /api/license-conclusions/unconclude    # inverse, same body shape (documented)
DELETE /api/license-conclusions/{url-encoded-dependency-locator}   # body {scope, scopeId} (informal)
```

Body (essentials): `dependencyRevisionLocator`, the concluded `licenseId`, and `scope` — one of `PROJECT`, `REVISION`, `ORGANIZATION`, `RELEASE_GROUP`, `RELEASE`, `GLOBAL` (`ORGANIZATION` is the normal choice; scoped variants also carry the scope's id). Since CORE-7665 (FOSSA `b531750893`, 2026-10) the scope's target is resolved inside your organization before anything is written: a `projectLocator` / `revisionLocator` that is not one of your org's projects, or a `releaseGroupId` / `releaseId` from another org, answers **404** (`Project not found` / `Release group not found` / `Release not found` — `routes/licenseConclusions/licenseConclusions.ts:88-116` → `modules/LicenseManager/conclusionTargets.ts:10-35`), and the ids the server derives from the authorized target win over anything you put in the body.

**Promote a local conclusion to the whole organization** — optional `replaceScope` (**documented**, CORE-7665, FOSSA `3a51a8b60e`, 2026-10-12): only valid when `scope.scope` is `ORGANIZATION` (otherwise 400 `replaceScope is only allowed with the organization scope` — `routes/licenseConclusions/validators.ts:81-84`). Send the project/revision/release-group/release scope the conclusion currently lives at; the organization row is seeded from the licenses concluded _there_ (`licenseConclusions.ts:195`, `seedScope` in `modules/LicenseManager/conclusions.ts:393`, read at `:419`), and that scope's own rows are deleted in the same transaction so the org conclusion shows through — a `REVISION` replaceScope also removes its project's row, a `RELEASE` one also removes its release group's (`getOutrankingScopes`, `licenseConclusions.ts:121-145`; transaction `:246-252`). Without `replaceScope`, an org-scope conclude leaves any project/release-group conclusion in place and that one keeps outranking the org's (priority ladder below).

Two things to know **before** you use conclusions:

- **Conclusions do not clear `unlicensed_dependency` issues.** FOSSA's unlicensed-dependency scanner tests the dependency's license list, and org-scope concluded licenses are carried in a separate field the scanner ignores. If your goal is "make these 22 unlicensed-dependency issues go away," use project corrections (mechanism 1). Conclusions are the right tool when the goal is org-wide license _data_ (reports, SBOMs, policy evaluation).
- **Read-back gotcha:** org-scope conclusions do **not** appear in the v1 dependencies list (`GET /api/revisions/{REV}/dependencies`). Read them back through the **v2** dependencies list of a revision that uses the dependency — each entry carries a `conclusions` object once the organization has the concluded-license feature (`routes/dependenciesV2/index.ts:76-81` → `isLicenseConcludedEnabled`; the hydrator reads at that revision's scope, `modules/LicenseManager/hydrateLicenseForDependencies.ts:156-168`, so org rows arrive via the priority ladder below). Filter to the one dependency with `exactLocators[]`:

```bash
curl -sg -H "Authorization: Bearer $FOSSA_API_KEY" \
  "https://app.fossa.com/api/v2/revisions/{url-encoded-REV}/dependencies?exactLocators[]={url-encoded-dependency-locator}" \
  | jq '.dependencies[0].conclusions'
# same object on the single-dependency read: GET /api/v2/revisions/{REV}/dependencies/{DEP} → .dependency.conclusions
```

⚠ The older read-back `GET /api/v2/revisions/{dependency-locator}/correction/conclusions` now answers **404 `Project not found`** for any locator that is not one of your org's own projects — since CORE-7665 (FOSSA `b531750893`) it asserts the locator's package is an org project before reading (`routes/revisions/correctionsV2.ts:223-231` → `conclusionTargets.ts:10-15`). Live-verified 2026-10-15 on org 32098: `mvn+junit:junit$4.13.2` and a `deb+…` dependency both 404; the same dependency read through the v2 list above returns its `conclusions`. Only use that route with one of your own revision locators.

- **Read-back shape**: `{ "scoped": { "licenses", "lastEditedBy", "updatedAt", "scope", "hasOrganizationConclusion" }, "base": { "licenses", "justification", … } }` (**documented**: `docs/swagger/schemas/conclusionData.yaml`). `base` is FOSSA's automated conclusion (or a FOSSA-admin _global_ override when one exists) with its justification; `scoped` is the highest-priority conclusion visible at the requested scope **falling back to base** — so `scoped == base` does not prove no human conclusion exists. The discriminator is `scoped.scope`: `null` = fell back to the automated row, `global` = FOSSA admin, anything else = a conclusion at that scope (source: `modules/LicenseManager/conclusions.ts:49-205`, priority ladder automated < global < organization < project/release_group < revision/release — the `CASE … END as priority` at `:118-124`). `scoped.hasOrganizationConclusion` (CORE-7665, FOSSA `3a51a8b60e`) is `true` when the organization has its own _user_ conclusion for the dependency revision even if a project/release-group row outranks it here; it is only present on project, revision, release-group and release reads, never on org or global ones, and correction side-effect rows do not count (`conclusions.ts:201-227`, `:303`, `:324`). Live 2026-10-15 on a 25-dependency page: every entry carried the field, `false` throughout. One caveat on organizations with the `legalAgent` feature flag (CORE-7657, FOSSA `b68ad49543`, 2026-09-29): FOSSA's Legal Agent keeps its own `is_legal_agent` conclusion rows, which rank between automated and global (`:121`) and are filtered out for every org without the flag (`:172-186`); a human upsert or delete never touches them (`:437`, `:469`), and a reset of a project correction leaves them in place (`modules/ProjectCorrectionManager/index.ts:421-429`). The read-back does not expose the flag (the select list at `:106-114` has no such column), so on a flagged org a non-null `scoped.scope` can be the Legal Agent's row rather than a person's — and `base` itself (hence the `scoped.scope: null` fallback) is the Legal Agent's own base row, not FOSSA's standard automated one: exactly one base row is read per revision, chosen by the flag, with no fallback between the two (`:142-145`, `:200-203`, `:222-227`). Flagged orgs also get an activity feed of what the Legal Agent concluded and what teammates edited — `GET /api/legal-agent/activity?limit=25` (cursor `before`, filters `projectLocator` / `releaseGroupId` / `actor=agent|user`) and `GET /api/legal-agent/activity/conclusions?rootRevisionLocator=…&hour=…` for the dependencies behind one entry (`docs/swagger/paths/legal_agent/*.yaml`, marked `x-internal`; requires premium + the flag — an org without it gets 403 `legalAgent is not enabled in this organization.`, live 2026-10-15 on 32098).
- **There is no org-wide list endpoint** — `GET /api/license-conclusions` and `GET /api/v2/license-conclusions` both 404 (live-verified 2026-09-16). Auditing who concluded what across an org means the per-revision endpoint above per locator, or the database (`"RevisionLicenseConclusions"`: `scope IS NULL` = automated; any other scope = a scoped row). Project corrections ALSO write org-scope conclusion rows as a side-effect — stamped `'system'` when created through `ProjectCorrection.fromLocator` (`models/projectcorrection/model.ts:238-243`) or with the correcting user's email/username through `ProjectCorrectionManager` (`index.ts:614-621`) — so `last_edited_by` alone does not separate direct human conclusions from correction side-effects; cross-check `"ProjectCorrections"`.

## 3. Validate license IDs before writing

The server does **not** validate `licenseId` strings on these writes — a typo becomes bad data silently. Pre-check every ID (sub-second, read-only):

```bash
curl -s -o /dev/null -w "%{http_code}" \
  -H "Authorization: Bearer $FOSSA_API_KEY" \
  "https://app.fossa.com/api/licenses/MIT"        # 200 = valid id
```

FOSSA license IDs are mostly SPDX (`MIT`, `Apache-2.0`, `GPL-2.0-or-later`), plus some FOSSA-specific ones. When correcting a Linux-distro package, prefer the license stated in the distro's own copyright file (e.g. `changelogs.ubuntu.com/.../copyright`) over guessing from the upstream project.

## Bulk correction discipline

Applying corrections at scale (tens to thousands), follow the pattern that has survived production use:

1. **Plan file first** — build a JSON plan (`locator`, `projectLocator`, `licenseId`, `copyright`, `parentRevisionLocator`, source URL for the license determination) before any write. Keep the evidence.
2. **Test gate** — run ONE correction, read it back, confirm the shape, then run the rest.
3. **Checkpoint** — append each completed write to a checkpoint file so an interrupted run resumes without double-writing.
4. **Read back every write** — a 200 is not verification; the read-back matching your intent is.
5. **Verify the outcome, not just the writes** — if the goal was clearing issues, poll the issue count until it drops (allow for queue lag).
