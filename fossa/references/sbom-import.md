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

- **Components with purls become native FOSSA locators** (29 purl types: npm, mvn, pip, go, deb, apk, cargo, gem, nuget, github, generic, …). For known packages, **FOSSA's registry licenses override whatever the SBOM declares** (live-verified: a component declared license-less came back `MIT + CC0-1.0` from the registry).
- `pkg:generic` purls get a best-effort registry match by name+version; unmatched ones need a `download_url`/`vcs_url` qualifier or fall through to user-defined.
- **Components without purls become user-defined dependencies** carrying the SBOM's name/version/license (`expression` > `license.id` > `license.name`; SPDX: `licenseConcluded` > `licenseDeclared`).
- `pkg:githubactions` components are **silently dropped** (unsupported type).
- `dependencies[]` present → real direct/transitive graph (verified live: a component referenced only in another's `dependsOn` imports as transitive). Absent/empty → every component imports as direct.

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
- Remove a test import: `DELETE /api/projects/{project-locator}` (no `$revision`; needs Project Delete).
