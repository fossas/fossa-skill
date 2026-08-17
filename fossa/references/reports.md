# Attribution reports and SBOMs

One endpoint family produces attribution reports, SBOMs, and license notices — the difference is the `format` parameter.

## Download a report

```
GET /api/revisions/{url-encoded-revision-locator}/attribution/download?download=true&format={FORMAT}&includeDirectDependencies=true&includeDeepDependencies=true
```

```bash
curl -s -H "Authorization: Bearer $FOSSA_API_KEY" \
  "https://app.fossa.com/api/revisions/custom%2B1234%2Fmy-project%24my-rev/attribution/download?download=true&format=CYCLONEDX_JSON&includeDirectDependencies=true&includeDeepDependencies=true" \
  -o sbom.cdx.json
```

Formats: `CYCLONEDX_JSON`, `CYCLONEDX_XML`, `SPDX_JSON`, `SPDX` (tag-value), `CSV`, `HTML`, `MARKDOWN`, `TEXT`, `JSON` (FOSSA-native).

Endpoint variants, so you can match what you see elsewhere: `…/attribution/json` (FOSSA-native JSON; in the published spec) and `…/attribution/full/{FORMAT}` (what the official CLI calls for the other formats). The `…/attribution/download?format=` form above is the one the FOSSA web UI uses — informal but production-proven, and the most convenient single shape. All three serve the same report family. For a **release-group-wide** report (all projects in a release, async job + poll), see `policies-and-projects.md`.

Before pulling a report on a freshly scanned revision, confirm the dependency cache is ready (`GET /api/cli/{REV}/dependencies-cache/status` → `READY`, see `scans-and-issues.md`) — earlier pulls can be incomplete.

Choosing:

- **Complete per-component data in one call** (license id + full license text + copyright + supplier) → `CYCLONEDX_JSON`. License text arrives **base64-encoded** in `components[].licenses[].license.text.content`; copyright in `components[].copyright`. SPDX_JSON also carries texts but in a side table (`hasExtractedLicensingInfos`), which is more work to join.
- **Human-readable notices file** → `HTML`, `MARKDOWN`, or `TEXT`.
- **Spreadsheet triage** → `CSV`.

Flags that bite:

- `includeDeepDependencies=true` is required for transitive dependencies — without it you get direct-only and a report a fraction of the real size.
- Large reports take time to assemble — parts of report generation run 30–60s. Use a generous curl timeout (`-m 300`) and treat a slow response as normal, not failure.
- **Scope difference vs the dependencies API**: attribution reports include first-party components (your own modules); the dependencies API returns third-party only. If you feed a compliance tool, filter your own namespace out of the report (by purl namespace or supplier) rather than being surprised by the count difference.

## Report data quality checks

- Coverage is real but not 100% — expect some components without copyright text (extraction depends on what's in the package source). Missing copyright ≠ missing license; check them separately.
- **Vendored/archive-uploaded components**: use the `attribution/download` endpoint as shown above (the default report engine keeps vendored and first-party components). Alternative report paths that some tooling uses can drop vendored components — if a component you expect is missing from a report, this scope difference is the first thing to check.

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

- **The server caps page size at 100** regardless of a larger `count` — a request with `count=6000` silently returns 100 rows. Always loop pages until you've collected `total`. Treating one page as the full set is a known way to "lose" dependencies that are actually there.
