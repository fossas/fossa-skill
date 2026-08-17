# Packages, locators, and the registry

## Locator grammar (everything in FOSSA keys off this)

A **locator** identifies a package revision: `{fetcher}+{package}${revision}`.

| Ecosystem         | Shape                                                  | Example                                                  |
| ----------------- | ------------------------------------------------------ | -------------------------------------------------------- |
| Maven             | `mvn+{group}:{artifact}${version}`                     | `mvn+com.fasterxml.jackson.core:jackson-databind$2.15.2` |
| npm               | `npm+{name}${version}`                                 | `npm+lodash$4.17.21`                                     |
| PyPI              | `pip+{name}${version}`                                 | `pip+requests$2.31.0`                                    |
| Go                | `go+{module-path}${version-or-sha}`                    | `go+k8s.io/klog/v2$v2.100.1`                             |
| Debian/Ubuntu     | `deb+{name}#{distro}#{distroVersion}${arch}#{version}` | `deb+libacl1#ubuntu#22.04$amd64#2.3.1-1`                 |
| Alpine            | `apk+{name}#{distro}#{distroVersion}${arch}#{version}` | `apk+musl#alpine#3.18$x86_64#1.2.4-r1`                   |
| Your own projects | `custom+{orgId}/{projectName}`                         | `custom+1234/github.com/acme/api-server`                 |
| Archive uploads   | `archive+{orgId}/{name}`                               | `archive+1234/vendor-blob`                               |

- A **project locator** has no `$revision`; a **revision locator** appends `${revision}` (for `custom+` projects the revision is usually a branch name, commit SHA, or CLI-provided `-r` value).
- **Always URL-encode locators in paths**: `+` → `%2B`, `/` → `%2F`, `$` → `%24`, `:` → `%3A`, `#` → `%23`.

```bash
enc() { jq -rn --arg v "$1" '$v|@uri'; }   # helper: URL-encode a locator
LOC=$(enc 'custom+1234/my-project$main')
```

- Case matters. Distro names are lowercase (`ubuntu`, not `Ubuntu`) — capitalized distro locators can fail enrichment even though the package is supported.

## Search the package index — documented

Find packages by name when you don't know the exact coordinate:

```
GET /api/registry-search/packages?fetcher={mvn|npm|pip|go|…}&q={name}&limit=20
GET /api/registry-search/versions?fetcher={fetcher}&package={package}&q=&limit=20
```

The first finds package coordinates matching `q` in one ecosystem; the second lists known versions of a package. Both are in the published API spec.

## Fetch one package's metadata + licenses — documented

```
GET /api/v2/dependencies/{url-encoded-locator}?includeLicenseText=false&includeCopyright=false
```

Response is wrapped: `{ "dependency": { … } }`. Flip `includeLicenseText`/`includeCopyright` to `true` when you need the texts (bigger payload).

## Probe the registry for a package's metadata (sub-second, no scan)

Before asserting "package X has license Y" — or before remapping a dependency to a locator you _think_ is right — probe FOSSA's registry directly (informal endpoint, same data the UI uses):

```bash
curl -s -H "Authorization: Bearer $FOSSA_API_KEY" \
  "https://app.fossa.com/api/revisions/$(enc 'mvn+junit:junit$4.13.2')" \
  | jq '{loc: .locator, licenses: [.licenses[]?.licenseId]}'
# → {"loc":"mvn+junit:junit$4.13.2","licenses":["EPL-1.0"]}
```

- 200 with license data → FOSSA knows the package; a remap to this locator will resolve.
- 200 with empty `licenses` → FOSSA resolves the identity but has no license data (candidate for a license conclusion, see `license-corrections.md`).
- 404 → not in the registry under that exact coordinate; do not remap to it.

This response also carries `project.projectCorrection` (your org's corrections, if any) — the read-back target after a correction write.

## Finding the right coordinate

When a name alone isn't enough (Maven artifact without a group, ambiguous npm name):

1. Probe the obvious candidates via the registry endpoint above — cheap, definitive.
2. Check the public registry (search.maven.org, npmjs.com, pypi.org) for the canonical coordinate, then confirm with a FOSSA probe.
3. Beware near-miss packages: a plausible-looking coordinate can be a _different_ project that happens to share the artifact name (repackaged forks, name-squats). If the probed license doesn't match the package's known license, you probably have the wrong coordinate.
