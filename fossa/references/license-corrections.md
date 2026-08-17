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

Body (essentials): `dependencyRevisionLocator`, the concluded `licenseId`, and `scope` — one of `PROJECT`, `REVISION`, `ORGANIZATION`, `RELEASE_GROUP`, `RELEASE`, `GLOBAL` (`ORGANIZATION` is the normal choice; scoped variants also carry the scope's id).

Two things to know **before** you use conclusions:

- **Conclusions do not clear `unlicensed_dependency` issues.** FOSSA's unlicensed-dependency scanner tests the dependency's license list, and org-scope concluded licenses are carried in a separate field the scanner ignores. If your goal is "make these 22 unlicensed-dependency issues go away," use project corrections (mechanism 1). Conclusions are the right tool when the goal is org-wide license _data_ (reports, SBOMs, policy evaluation).
- **Read-back gotcha:** org-scope conclusions do **not** appear in the plain dependencies list response. Verify via the dedicated endpoint:

```bash
curl -s -H "Authorization: Bearer $FOSSA_API_KEY" \
  "https://app.fossa.com/api/v2/revisions/{url-encoded-locator}/correction/conclusions"
```

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
