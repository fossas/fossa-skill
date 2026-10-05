# Attribution reports and SBOMs

One endpoint family produces attribution reports, SBOMs, and license notices — the difference is the `format` parameter.

## Download a report

The default recipe — every section and every per-component column switched on, nothing to forget (**documented**; this is what the official CLI calls):

```
GET /api/v2/revisions/{url-encoded-revision-locator}/attribution/full/{FORMAT}
```

```bash
curl -s -m 300 -H "Authorization: Bearer $FOSSA_API_KEY" \
  "https://app.fossa.com/api/v2/revisions/custom%2B1234%2Fmy-project%24my-rev/attribution/full/CYCLONEDX_JSON" \
  -o sbom.cdx.json
```

Formats: `CYCLONEDX_JSON`, `CYCLONEDX_XML`, `SPDX_JSON`, `SPDX` (tag-value), `CSV`, `HTML`, `MARKDOWN`, `TEXT`, `JSON` (FOSSA-native).

The fine-grained form is `…/attribution/download` (**documented**), where you choose the report _sections_ with `include*` flags **and must also choose the per-component _columns_** with `dependencyInfoOptions[]` — ⚠ without the column list the report has component names and nothing else:

```
GET /api/v2/revisions/{REV}/attribution/download?download=true&format={FORMAT}
    &includeDirectDependencies=true&includeDeepDependencies=true&includeNonLicenseCopyrights=true
    &dependencyInfoOptions[]=License&dependencyInfoOptions[]=OtherLicenses&dependencyInfoOptions[]=ConcludedLicense
    &dependencyInfoOptions[]=FullTextLicense&dependencyInfoOptions[]=Copyrights&dependencyInfoOptions[]=Authors
```

(`curl -g` or hand-encode the `[]` — curl otherwise treats brackets as a glob.) Other variants you will meet: `…/attribution/json` (FOSSA-native JSON; in the published spec); `full` works with or without the `/v2` prefix; the no-prefix `download` form is not in the published spec (history below).

**Why the column list is mandatory on `download`.** The v2 handler starts from an empty column set (`routes/revisions/reportsV2.ts:116`, `new Set(query.dependencyInfoOptions ?? [])`; each column maps to one option at `:163-181`), and the code itself says V1 callers who never sent it get "no license, copyright or author detail" (`:504-508`). Live-verified 2026-10-01 on org 32098: `download?format=CYCLONEDX_JSON` with only the `include*` flags → 0 of 146 components carrying a `licenses` array (SPDX_JSON: every package `NOASSERTION`); adding the six options above → 144/146 licensed, 142 with base64 license text, 71 with `copyright`; adding `includeNonLicenseCopyrights=true` as well → 83 with `copyright`, identical to `attribution/full/CYCLONEDX_JSON` (83). The copyright rule, from source: a component's `copyright` is emitted only when at least one license option is on AND `Copyrights` is on (`modules/ReportService/cycloneDx/buildCycloneDxComponents.ts:43-50`), and copyrights found in source files that are not tied to a license are merged in only when the `includeNonLicenseCopyrights` section is on (`modules/ReportService/ReportDependency.ts:365-378`; `reportsV2.ts:155`). Option names are the keys of `DependencyInfoOptions` (`shared/reports/index.ts:32-52`): `Library`, `Authors`, `Description`, `ConcludedLicense`, `License` (declared), `CustomTextLicense`, `FullTextLicense`, `LicenseTextAppendix`, `OtherLicenses` (discovered), `FilePath`, `Source`, `ProjectUrl`, `PackageDownloadUrl`, `DependencyPaths`, `IssueNotes`, `Copyrights`, `NoticeFiles`, `LicenseFileURL` (`Project` is release-group only). Two of them do nothing on this route: notice files are driven by the section flag `includeNoticeFiles=true` (`reportsV2.ts:177`), and `Library` is not mapped. `attribution/full/{FORMAT}` sidesteps all of this — `getFullReportConfig()` (`reportsV2.ts:413`; `shared/reports/utils.ts:117-166`) turns every section, including non-license copyrights, and every column on.

**Prefix history, so old advice makes sense.** The no-prefix `/api/revisions/{REV}/attribution/download` used to run a separate legacy engine over a dependency store that was being retired — on organizations already moved off it, it returned HTTP 200 with **zero components** (live-observed 2026-09-21: no prefix → 0, `/v2` → 309, `full` → 309). Since CORE-7252 (FOSSA `811be900b4`, develop 2026-09-30) the no-prefix route delegates to the same ReportService handler as `/v2` (`routes/revisions/revisions.ts:1490-1498` → `generateAttributionDownloadV3`), keeping two V1 quirks: it answers `Content-Type: application/octet-stream` + `Content-Disposition: inline` (`legacyHeaders`), and it defaults the per-component columns to the project's BOM column settings or `Library, License, CustomTextLicense, OtherLicenses` (`legacyDependencyInfoOptions`, `modules/ReportService/convertFromLegacyOptions.ts:11-31`) — which is why the no-prefix form returns licenses without `dependencyInfoOptions[]` while `/v2` does not — but never copyrights, since `Copyrights` is not in the legacy default (live-verified 2026-10-01, 146-component revision, `include*` flags only: no prefix → 144 licensed, 0 with `copyright`; `/v2` → 0 licensed). Still prefer `/v2` or `full`: they are the documented forms and the only ones with per-format content types. If a project that plainly has dependencies exports an empty SBOM, check in order: the dependency cache is not `READY` yet (below); neither `includeDirectDependencies` nor `includeDeepDependencies` was passed; the organization is on a deployment that predates CORE-7252 and you used the no-prefix form. For a **release-group-wide** report (all projects in a release, async job + poll), see `policies-and-projects.md`.

Before pulling a report on a freshly scanned revision, confirm the dependency cache is ready (`GET /api/cli/{REV}/dependencies-cache/status` → `READY`, see `scans-and-issues.md`) — earlier pulls can be incomplete.

Choosing:

- **Complete per-component data in one call** (license id + full license text + copyright + supplier) → `attribution/full/CYCLONEDX_JSON` (or the `download` form above with the full column list **and** `includeNonLicenseCopyrights=true` — drop the column list and the components carry no license at all; drop the non-license-copyright flag and roughly one copyright in seven goes missing, silently). License text arrives **base64-encoded** in `components[].licenses[].license.text.content`; copyright in `components[].copyright`. SPDX_JSON also carries texts but in a side table (`hasExtractedLicensingInfos`), which is more work to join.
- **Human-readable notices file** → `HTML`, `MARKDOWN`, or `TEXT`.
- **Spreadsheet triage** → `CSV`.

Flags that bite:

- `includeDeepDependencies=true` is required for transitive dependencies — without it you get direct-only and a report a fraction of the real size (verified: 121 of 309 components).
- **Vulnerabilities are opt-in on `download`**: add `includeOpenVulnerabilities=true` (and `includeClosedVulnerabilities=true` if wanted; `includeVulnerabilities=true` switches on both) to get the CycloneDX `vulnerabilities[]` array, one entry per CVE with CVSS rating and `analysis.state`. `attribution/full` includes them without flags. Only CycloneDX carries vulnerabilities — SPDX exports have no vulnerability section — and FOSSA leaves them out for organizations below the premium tier.
- Large reports take time to assemble — parts of report generation run 30–60s. Use a generous curl timeout (`-m 300`) and treat a slow response as normal, not failure.
- **Scope difference vs the dependencies API**: attribution reports include first-party components (your own modules); the dependencies API returns third-party only. If you feed a compliance tool, filter your own namespace out of the report (by purl namespace or supplier) rather than being surprised by the count difference.
- **The root component carries the project's own licensing** (CORE-7693, FOSSA `13237af3ea`, develop 2026-10-01 — code-sourced, not yet live-verified from this skill; confirm on your deployment). CycloneDX: `metadata.component` on a project report — and each project's root component on a release-group report when `includeFOSSADependencies` is on (`modules/ReportService/cycloneDx/buildCycloneDxBom.ts:45-47`) — gains `licenses[]` (declared + discovered, de-duplicated by id, base64 text, never marked concluded), a newline-joined `copyright`, and one `properties[]` entry per notice file (`modules/ReportService/cycloneDx/buildRootComponentLicensing.ts:16-56`). SPDX: the root package's `licenseDeclared` and `copyrightText` are filled instead of `NONE`; a section that is off yields `NOASSERTION`, `NONE` now means FOSSA looked and found nothing, and `licenseConcluded` is always `NOASSERTION` (`modules/ReportService/spdx/buildSpdxRootPackage.ts:33,83-89`). Which pieces appear follows the *section* flags, not `dependencyInfoOptions[]`: `includeProjectLicense` → declared, `includeLicenseScan` → discovered, `includeNoticeFiles` → notice properties, `includeNonLicenseCopyrights` → copyrights found outside licenses (`routes/revisions/reportsV2.ts:141-155`); `attribution/full` turns them all on (`shared/reports/utils.ts:117-122`). On deployments that predate this, the root is an unlicensed shell (SPDX `NONE`) — that is the old shape, not a scan failure.

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
