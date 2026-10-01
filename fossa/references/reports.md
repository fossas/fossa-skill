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

**`/v2` `download` ships components with NO license, copyright or author fields unless you ask for them.** The `include*` flags choose report _sections_; the per-component _columns_ are a separate opt-in, `dependencyInfoOptions[]`, and the v2 handler starts from an empty set (`routes/revisions/reportsV2.ts:116`, `new Set(query.dependencyInfoOptions ?? [])`; each column maps to one option at `:163-181`). Live-verified 2026-10-01 on the same revision, same `include*` flags: `/v2 download?format=CYCLONEDX_JSON` → every component without a `licenses` array (SPDX_JSON: every package `NOASSERTION`); the same URL plus `&dependencyInfoOptions[]=License&dependencyInfoOptions[]=OtherLicenses&dependencyInfoOptions[]=ConcludedLicense&dependencyInfoOptions[]=FullTextLicense&dependencyInfoOptions[]=Copyrights&dependencyInfoOptions[]=Authors` → license id + base64 text on every component. Option names (`shared/reports/index.ts:57-77`): `Library`, `Authors`, `Description`, `ConcludedLicense`, `License` (declared), `CustomTextLicense`, `FullTextLicense`, `OtherLicenses` (discovered), `FilePath`, `Source`, `ProjectUrl`, `PackageDownloadUrl`, `DependencyPaths`, `IssueNotes`, `Copyrights`, `NoticeFiles`, `LicenseFileURL`. When you want everything, skip the flag soup: `attribution/full/{FORMAT}` turns every section and column on (`getFullReportConfig()`, `reportsV2.ts:413`) — in the same probe it was the only variant that also returned `copyright` on the components.

**Prefix history, so old advice makes sense.** The no-prefix `/api/revisions/{REV}/attribution/download` used to run a separate legacy engine over a dependency store that was being retired — on organizations already moved off it, it returned HTTP 200 with **zero components** (live-observed 2026-09-21: no prefix → 0, `/v2` → 309, `full` → 309). Since CORE-7252 (FOSSA `811be900b4`, develop 2026-09-30) the no-prefix route delegates to the same ReportService handler as `/v2` (`routes/revisions/revisions.ts:1490-1498` → `generateAttributionDownloadV3`), keeping two V1 quirks: it answers `Content-Type: application/octet-stream` + `Content-Disposition: inline` (`legacyHeaders`), and it defaults the per-component columns to the project's BOM column settings or `Library, License, CustomTextLicense, OtherLicenses` (`legacyDependencyInfoOptions`, `modules/ReportService/convertFromLegacyOptions.ts:11-31`) — which is why the no-prefix form returns licenses without `dependencyInfoOptions[]` while `/v2` does not (live-verified 2026-10-01: same revision, no prefix → 3/3 components licensed; `/v2` → 0/3). Still prefer `/v2` or `full`: they are the documented forms and the only ones with per-format content types. If a project that plainly has dependencies exports an empty SBOM, check in order: the dependency cache is not `READY` yet (below); neither `includeDirectDependencies` nor `includeDeepDependencies` was passed; the organization is on a deployment that predates CORE-7252 and you used the no-prefix form. For a **release-group-wide** report (all projects in a release, async job + poll), see `policies-and-projects.md`.

Before pulling a report on a freshly scanned revision, confirm the dependency cache is ready (`GET /api/cli/{REV}/dependencies-cache/status` → `READY`, see `scans-and-issues.md`) — earlier pulls can be incomplete.

Choosing:

- **Complete per-component data in one call** (license id + full license text + copyright + supplier) → `attribution/full/CYCLONEDX_JSON` (or `/v2 …/download?format=CYCLONEDX_JSON` with the `dependencyInfoOptions[]` list above — without it the components carry no license at all). License text arrives **base64-encoded** in `components[].licenses[].license.text.content`; copyright in `components[].copyright`. SPDX_JSON also carries texts but in a side table (`hasExtractedLicensingInfos`), which is more work to join.
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
