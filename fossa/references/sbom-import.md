# Importing SBOMs (SBOM file → FOSSA project)

Import a vendor's or tool's SBOM as a first-class FOSSA project — components resolve against FOSSA's registry, licenses and vulnerabilities attach, and every post-scan workflow (issues, reports, policies) works on the result. Enterprise feature.

## Accepted formats

| Format | Versions | Encoding |
|---|---|---|
| CycloneDX | 1.2 – 1.7 | JSON and XML |
| SPDX 2.x | 2.2, 2.3 | **JSON only** (SPDX XML is rejected with an explicit error) |
| SPDX 3.x | 3.0.0, 3.0.1 | JSON-LD |

A `{"sbom": {...}}` wrapper is unwrapped automatically.

## How components resolve (what to expect)

- **Components with purls become native FOSSA locators** (31 purl types: npm, mvn, pip, go, deb, apk, rpm, cargo, gem, nuget, github, generic, … — `conan` and `conda` were added 2026-09-28; the full list is the converter registry at `modules/sbom/shared/converters/index.ts:34-66`). For known packages, **FOSSA's registry licenses override whatever the SBOM declares** (live-verified: a component declared license-less came back `MIT + CC0-1.0` from the registry).
- **`pkg:github/{owner}/{repo}@{tag-or-sha}` is the route for C/C++ and other unpackaged source**: it becomes `git+github.com/{owner}/{repo}$<commit>`, FOSSA license-scans the upstream repository, and CVEs attach by version (live-verified: `pkg:github/openssl/openssl@openssl-3.5.7` → the tag's commit, 24 CVEs). Owner and repo are lowercased on import (verified with `pkg:github/Mbed-TLS/mbedtls`), so SBOM purls are not exposed to the case-sensitive CVE matching that bites hand-written `fossa-deps` `git` names (see `dependency-fixes.md`).
- **A component's `cpe` field opens a second CVE path.** Components with no resolvable purl import as user-defined `user+…` dependencies, which have no ecosystem identity for FOSSA to match vulnerability data against; a `cpe` gives them one. Live-verified: a bare component with `cpe:2.3:a:tianocore:edk2:202311:*:*:*:*:*:*:*` imported as `user+…` with 16 CVEs. The CPE's *product* is what selects the CVE set; a version range is applied only where the matched advisory carries one, and entries recorded as unpatched (range `*`) come back for every version. That is what happened here: all 16 entries carried the range `*`, so `202311`, `202402` and `202608` returned the same list. Treat CPE-sourced CVEs as a watchlist to triage once, not as a statement that your version is affected.
- `pkg:generic` purls get a best-effort registry match by name+version; unmatched ones need a `download_url`/`vcs_url` qualifier or fall through to user-defined.
- **Components without purls become user-defined dependencies** carrying the SBOM's name/version/license (`expression` > `license.id` > `license.name`; SPDX: `licenseConcluded` > `licenseDeclared`).
- **License Conclusion on imported components**: FOSSA concludes per dependency revision from its own license data, never from the SBOM — see the section below for the gate, the triage order and the read-back.
- `pkg:githubactions` components are **silently dropped** (unsupported type).
- `dependencies[]` present → real direct/transitive graph (verified live: a component referenced only in another's `dependsOn` imports as transitive). Absent/empty → every component imports as direct.

## License Conclusion on imported components

An imported component is treated exactly like a scanned dependency: FOSSA concludes per dependency revision, from its own license data, never from the SBOM. Source-traced at FOSSA develop `5a248a1963` (2026-10-28).

Conclusions are enabled when the deployment has them on (`llm:enabled` AND `llm:features:concludeLicenses:enabled`, `modules/FeatureManager/deploymentFeatures.ts:18-19`) AND the organization's License Conclusion setting is on (Settings → Organization → General → Features, `Organizations.licenseConcludedEnabled`; `modules/LicenseManager/conclusions.ts:648-664`); the old per-org `licenseConcluded` feature flag was retired by CORE-7634 (`1b181a0c0d`, 2026-09-17, first tag 4.34.109), so do not send anyone looking for it, and organizations on the Legal Agent flag take a separate conclusion path (`modules/BuildManager/index.ts:709-736`).

**What the setting gates and what it does not.** FOSSA writes the base conclusion row (`RevisionLicenseConclusions`, `scope IS NULL AND is_legal_agent = false`, shared by every organization that uses the dependency revision) during every dependency build whether or not the organization has the setting (`modules/BuildManager/index.ts:736`): exactly one declared license → that license; no declared and exactly one discovered → that one; several → the LLM pass, the one branch the setting gates (`modules/BuildManager/parse.ts:284`), which may decline and write nothing; none → unconcluded (`modules/BuildManager/parse.ts:268-320`). Top-level builds never conclude (`modules/BuildManager/parse.ts:194-198`) and the SBOM build is a top-level build (`faktory/jobs/builds/SBOMBuild/index.ts:106`). The setting gates two things: whether the API and UI return the `conclusions` object at all (`routes/dependenciesV2/index.ts:79-84` → `routes/dependenciesV2/utils.ts:10-22`, present but empty when off — the code comment at `routes/dependenciesV2/utils.ts:15` still calls this gate pre-GA and names CORE-5675, which was closed Won't Do on 2025-09-29; GA shipped under CORE-6390 (2026-10-13) and the organization toggle (CORE-6174) is the intended permanent control, so treat the read gate as current behaviour) and whether dependency resolution enqueues the asynchronous catch-up job for dependencies that have no settled base row yet (`ConcludeRevisionLicenses`: high-priority queue, 3 retries, 30-minute timeout, `faktory/jobs/backfill/ConcludeRevisionLicenses.ts:15-19`; enqueued from `modules/BuildManager/index.ts:493-506` and, for user-defined dependencies, `modules/DependencyManager/userDefinedFastPath.ts:102-131`; gate `modules/DependencyManager/setDeepDependencies.ts:146`).

**The SBOM's own concluded field is not imported.** `licenseConcluded` (SPDX `PackageLicenseConcluded`) never becomes a conclusion — nothing under `modules/sbom/` writes one: for purl components the registry licenses win (see "How components resolve" above), and for user-defined components it only selects the declared license (`licenseConcluded ?? licenseDeclared`, `modules/sbom/spdx/Converter.ts:84-92`, stored as a declared license group, `modules/UserDefinedProjectManager/licenses.ts:66-78`).

**Reading "one declared license, nothing concluded" on an import**, in order of likelihood:

1. The dependency has no base row yet — a user-defined component (never built, so only the catch-up job writes its row) or a package nobody has built since conclusions shipped — and the row arrives asynchronously after the import's dependency resolution. A registry package any organization's build already concluded shows up the moment the setting is on, no re-analysis needed.
2. The setting was turned on after the project's last analysis, so no catch-up was enqueued for it (the product's own wording: "will only take effect on individual projects upon their next analysis") — re-import.
3. The re-import was an identical SBOM within 24 h of the previous one and was served from the Sparkle build cache, which seeds every dependency as already resolved and skips the queue step that enqueues conclusions (`modules/DependencyManager/setDeepDependencies.ts:155-205`, `:238-250`; TTL `models/buildcache/model.ts:10`) — change the file or wait a day, unless the organization has Sparkle build caching disabled (`DISABLE_SPARKLE_BASED_BUILD_CACHING`, `setDeepDependencies.ts:159`) or the earlier import left no Sparkle analysis.
4. The row is the root package the SBOM describes, which became the project (top-level, never concluded).
5. Several licenses sit in one declared group and the LLM pass declined or reproduced the previous hash, so nothing was written (`modules/BuildManager/parse.ts:297-307`).

Read back with the dependency's `conclusions` object on the imported revision's v2 dependencies list (`GET /api/v2/revisions/{url-encoded-REV-locator}/dependencies?exactLocators[]={url-encoded-dependency-locator}` → `.dependencies[0].conclusions`, `license-corrections.md`; the per-dependency `/correction/conclusions` route 404s on third-party locators since CORE-7665). Empty base rows written before CORE-7330 (FOSSA 4.34.89, 2026-08-27) are retried on the next resolution (`isBaseConclusionSettled`, `modules/LicenseManager/conclusions.ts:345-349`).

## The raw API sequence (live-verified end to end)

`{NAME}` = project name, `{REV}` = revision. The resulting project locator is `sbom+{orgId}/{NAME}` (revision `${REV}`).

```bash
# 1. get a presigned upload URL (1h expiry)
SIGNED=$(curl -s -H "Authorization: Bearer $FOSSA_API_KEY" \
  "https://app.fossa.com/api/components/signed_url?packageSpec={NAME}&revision={REV}&fileType=sbom" | jq -r .signedUrl)

# 2. upload the SBOM file to the signed URL
curl -s -X PUT -H "Content-Type: binary/octet-stream" --data-binary @my-sbom.cdx.json "$SIGNED"

# 3. queue the import build
curl -s -X POST -H "Authorization: Bearer $FOSSA_API_KEY" -H "Content-Type: application/json" \
  "https://app.fossa.com/api/components/build?dependency=false&rawLicenseScan=false&fileType=sbom" \
  -d '{"archives":[{"packageSpec":"{NAME}","revision":"{REV}"}],"fullFiles":true,"forceRebuild":false}'
# → 201 Created

# 4. poll for completion (small SBOMs finish in seconds; job timeout is 6 hours)
curl -s -H "Authorization: Bearer $FOSSA_API_KEY" \
  "https://app.fossa.com/api/cli/$(enc "sbom+{orgId}/{NAME}\${REV}")/latest_build" | jq .task.status
```

Optional query params on step 3: `team`, `title`, `branch` (default `master`), `policy` / `policyId`, `releaseGroup`+`releaseGroupRelease` (paired), `dependency=true` to import as a dependency rather than a top-level project. Orgs with require-team-on-upload must pass `team`.

CLI equivalent: `fossa sbom analyze <file>` (`-p`/`-r` override the filename/timestamp defaults; `--force-rescan` re-analyzes an uploaded revision), then `fossa sbom test <file>` gates like `fossa test`.

## Verify and clean up

- Read back deps: `GET /api/v2/revisions/{REV-locator}/dependencies` — check locators are native (not `user+`) and depths match your `dependencies[]`.
- Export it back out with `GET /api/v2/revisions/{REV-locator}/attribution/full/CYCLONEDX_JSON` (see `reports.md`; the `…/attribution/download?…` form needs the `dependencyInfoOptions[]` column list and `includeNonLicenseCopyrights=true` or the exported components carry no licenses or copyrights). Round trip verified on a 309-component import: components, the dependency graph and the CVE list all survive, as CycloneDX 1.7.
- Remove a test import: `DELETE /api/projects/{project-locator}` (no `$revision`; needs Project Delete).
