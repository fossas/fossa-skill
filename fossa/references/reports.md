# Attribution reports and SBOMs

One endpoint family produces attribution reports, SBOMs, and license notices — the difference is the `format` parameter.

## Download a report

```
GET /api/v2/revisions/{url-encoded-revision-locator}/attribution/download?download=true&format={FORMAT}&includeDirectDependencies=true&includeDeepDependencies=true
```

```bash
curl -s -H "Authorization: Bearer $FOSSA_API_KEY" \
  "https://app.fossa.com/api/v2/revisions/custom%2B1234%2Fmy-project%24my-rev/attribution/download?download=true&format=CYCLONEDX_JSON&includeDirectDependencies=true&includeDeepDependencies=true" \
  -o sbom.cdx.json
```

Formats: `CYCLONEDX_JSON`, `CYCLONEDX_XML`, `SPDX_JSON`, `SPDX` (tag-value), `CSV`, `HTML`, `MARKDOWN`, `TEXT`, `JSON` (FOSSA-native).

Endpoint variants, so you can match what you see elsewhere: `…/attribution/json` (FOSSA-native JSON; in the published spec) and `…/attribution/full/{FORMAT}` (what the official CLI calls for the other formats: every report section switched on, no flags to pass; works with or without the `/v2` prefix). The `/api/v2/…/attribution/download?format=` form above is the one that honors per-section `include*` flags (**documented**, as is `/api/v2/…/attribution/full/{FORMAT}`; the no-prefix `download` form is not in the published spec).

**Keep the `/v2` prefix on `attribution/download`.** Without it (`/api/revisions/{REV}/attribution/download`) the request runs FOSSA's legacy report engine, which reads a dependency store that is being retired: on organizations already moved off it, the response is HTTP 200 with a well-formed report and **zero components**. Live-verified 2026-09-21 on one org, same revision, same flags: no prefix → 0 components; `/v2` → 309; `attribution/full/CYCLONEDX_JSON` → 309. So when a project that plainly has dependencies exports an empty SBOM, the missing `/v2` is the first thing to check, before concluding the scan is empty. The other common causes: the dependency cache is not `READY` yet (below), or neither `includeDirectDependencies` nor `includeDeepDependencies` was passed (empty on either engine). For a **release-group-wide** report (all projects in a release, async job + poll), see `policies-and-projects.md`.

Before pulling a report on a freshly scanned revision, confirm the dependency cache is ready (`GET /api/cli/{REV}/dependencies-cache/status` → `READY`, see `scans-and-issues.md`) — earlier pulls can be incomplete.

Choosing:

- **Complete per-component data in one call** (license id + full license text + copyright + supplier) → `CYCLONEDX_JSON`. License text arrives **base64-encoded** in `components[].licenses[].license.text.content`; copyright in `components[].copyright`. SPDX_JSON also carries texts but in a side table (`hasExtractedLicensingInfos`), which is more work to join.
- **Human-readable notices file** → `HTML`, `MARKDOWN`, or `TEXT`.
- **Spreadsheet triage** → `CSV`.

Flags that bite:

- `includeDeepDependencies=true` is required for transitive dependencies — without it you get direct-only and a report a fraction of the real size (verified: 121 of 309 components).
- **Vulnerabilities are opt-in on `download`**: add `includeOpenVulnerabilities=true` (and `includeClosedVulnerabilities=true` if wanted; `includeVulnerabilities=true` switches on both) to get the CycloneDX `vulnerabilities[]` array, one entry per CVE with CVSS rating and `analysis.state`. `attribution/full` includes them without flags. Only CycloneDX carries vulnerabilities — SPDX exports have no vulnerability section — and FOSSA leaves them out for organizations below the premium tier.
- Large reports take time to assemble — parts of report generation run 30–60s. Use a generous curl timeout (`-m 300`) and treat a slow response as normal, not failure.
- **Scope difference vs the dependencies API**: attribution reports include first-party components (your own modules); the dependencies API returns third-party only. If you feed a compliance tool, filter your own namespace out of the report (by purl namespace or supplier) rather than being surprised by the count difference.

## Report data quality checks

- Coverage is real but not 100% — expect some components without copyright text (extraction depends on what's in the package source). Missing copyright ≠ missing license; check them separately.
- **Vendored/archive-uploaded components** are part of the dependency sections on both `/v2` `download` and `full` (the report engine has included them alongside managed dependencies since July 2026). If a vendored component is missing, check that the org's vendored-dependency detection is enabled before suspecting the report.

## Reading attribution from the CLI

`fossa report attribution --json --project <p> --revision <r> --timeout 300` returns the FOSSA-native JSON. When projecting licenses from it, union **both** fields — registry-declared licenses live in `directDependencies[].licenses`, while licenses _discovered by scanning_ (vendored code, license files) live only in `directDependencies[].otherLicenses`:

```bash
fossa report attribution --json -p <project> -r <revision> --timeout 300 \
  | jq -r '.directDependencies[]? |
      "\(.title // .package) \(.version // "") -> \(( [(.licenses[]?.name), (.otherLicenses[]?.name)] | unique | join(", ")))"'
```

Projecting only `.licenses` makes correctly-scanned vendored dependencies look license-empty — a classic false "detection failed" conclusion.

## Structured dependency list (no texts, machine-friendly)

For a paginated, structured third-party dependency list (locator, declared/discovered licenses, depth, ignored/unknown flags) without license/copyright texts:

```
GET /api/v2/revisions/{url-encoded-revision-locator}/dependencies?count=100&page=1
```

- **The server clamps page size to [25, 100]** regardless of what you ask (`count=500` returns 100; `count=10` returns 25). Always loop pages until you've collected `total`.
- Server-side filters (flat params): `fetchers[]`, `licenses[]` (e.g. `Apache-2.0`), `depth[]` (direct|transitive), `hasIssues[]` (hasVulnIssues|hasLicensingIssues|hasQualityIssues|noIssues), `resolved`, `exactLocators[]` (exact) vs `locators[]` (substring), `layerDepth[]` (**base|other** for container layers — the issues API spells it `containerLayers[]=baseLayer|otherLayer`), `sources[]` (managed|vendored|snippet), plus hydration flags `includeLicenseText`/`includeCopyright`/`includeDownloadUrl`. Filtered `total` comes back in the body — use it instead of client-side counting.
