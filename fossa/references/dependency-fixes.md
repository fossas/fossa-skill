# Fixing wrong or unresolved dependencies

A dependency shows as **unknown/unresolved** (no license, "FOSSA was unable to resolve…") when its locator doesn't match anything FOSSA can fetch — wrong ecosystem prefix (a Debian package typed as `mvn+`), missing Maven groupId, wrong architecture, or a genuinely internal package. There are four repair levers. Choose by root cause:

| Root cause                                                                          | Fix                                                |
| ----------------------------------------------------------------------------------- | -------------------------------------------------- |
| Locator is _right_ but resolution is stale/failed (data since backfilled, arch fix) | **Re-resolve** the same locator                    |
| Locator is _wrong_ (wrong ecosystem/name/groupId)                                   | **Two-step remap**: add corrected dep → ignore old |
| Wrong at the source (hand-written `fossa-deps.yaml`)                                | **Fix the file** and re-scan                       |
| Package is internal / genuinely unfetchable                                         | **User-defined dependency** (+ ignore old)         |

**Durability rule: if the bad locator came from a file (`fossa-deps.yaml`), fix the file too.** API-side repairs fix the live revision, but the next scan re-reads the file and resurrects the bad entries. File-vs-revision divergence is a real regression class — always converge both.

All endpoints in this file are used by FOSSA's own web UI but are **not in the published API spec** (only the GET on the dependencies route is documented). They're stable in practice; treat them as informal.

In every path below, `{REV}` = your project **revision** locator, URL-encoded (e.g. `custom+1234/my-project$main` → `custom%2B1234%2Fmy-project%24main`), and `{DEP}` = the dependency locator, URL-encoded.

## 1. Re-resolve a dependency (same locator)

```
GET /api/revisions/{REV}/dependencies/{DEP}/resolve
```

Use when the locator is correct and FOSSA should now be able to resolve it (data backfill, transient failure). Failed resolutions are cached — a dep that failed once does not retry by itself; this endpoint forces it.

- Success: 200, dep re-resolves with license data; the unresolved row disappears.
- **HTTP 500 with `code: 1009` ("KnowledgeAPI was unable to resolve") is a permanent miss** — the package/version isn't in FOSSA's corpus (private packages, subscription-only distro repos, superseded point-versions dropped from the live index). Don't retry these; route them to a user-defined dependency or a license conclusion instead.

## 2. Two-step remap (wrong locator → corrected locator)

The API has a one-shot replace (`kind: "replace"` below), but it only works when the bad dependency lives in the resolved dependency graph. **Unresolved entries that originate from scan analysis or `fossa-deps.yaml` are outside that graph — replace 404s on them (`code: 2004`, "does not exist in the dependency graph").** The pattern that works everywhere, proven at scale:

**Step A — add the corrected dependency:**

```
POST /api/revisions/{REV}/dependencies
```

```json
{
  "dependencyData": {
    "kind": "new",
    "newDependency": {
      "kind": "locator",
      "fetcher": "mvn",
      "packageName": "org.apache.parquet:parquet-column",
      "revision": "1.13.1"
    }
  }
}
```

For deb/apk packages, distro coordinates go in **separate fields**, not in the name:

```json
{
  "dependencyData": {
    "kind": "new",
    "newDependency": {
      "kind": "locator",
      "fetcher": "deb",
      "packageName": "libacl1",
      "revision": "2.3.1-1",
      "distro": "ubuntu",
      "distroRelease": "22.04",
      "arch": "amd64"
    }
  }
}
```

**Step B — confirm it resolved.** Read the dependencies list (`GET /api/v2/revisions/{REV}/dependencies`, paginate) and check the added locator has licenses and `isUnknown: false`. Not every plausible correction resolves — a wrong Maven groupId can 200 on add and still be the wrong package. Probe the registry first (see `packages.md`) to raise the hit rate.

**Step C — only if Step B passed, ignore the old locator:**

```
PUT /api/revisions/{REV}/dependencies/{OLD_DEP}/ignore
```

The unknown count drops; the corrected dep carries the license data.

**If Step B failed**, remove the added dep so you don't leave clutter, and re-derive:

```
DELETE /api/revisions/{REV}/dependencies/{ADDED_DEP}
```

One-shot replace, for deps that ARE in the resolved graph (e.g. correcting a resolved-but-wrong dep):

```json
{
  "dependencyData": {
    "kind": "replace",
    "newDependency": {
      "kind": "locator",
      "fetcher": "…",
      "packageName": "…",
      "revision": "…"
    },
    "overwrittenLocator": "mvn+wrong:thing$1.0"
  }
}
```

If it returns 404 `code: 2004`, fall back to the two-step.

Deriving corrected locators, common classes:

- Debian/Ubuntu typed as `mvn+`/`pip+` → `deb` with `distro`/`distroRelease`/`arch` fields
- Maven artifact missing its groupId (`mvn+widget$1.0`) → find the real coordinate on Maven Central, probe it against FOSSA's registry, then use `group:artifact` as `packageName`
- Go vanity imports → the canonical module path (`k8s.io/klog/v2`)
- Never guess-and-ignore: ignore the old locator **only after** the corrected one demonstrably resolves.

## 3. Fix the source file (`fossa-deps.yaml`)

If the bad locators originate in a hand-written `fossa-deps.yaml`, correct the `type:` / `name:` / `version:` entries in the repo and re-analyze. Schema notes that bite:

- The Python type is **`pypi`**, not `pip`.
- Maven `name` is **`group:artifact`** (both parts).
- `deb` is a first-class referenced-dependency type: `type: deb` with `name`, `version`, `os` (lowercase, e.g. `ubuntu`), `osVersion`, `arch`.
- **One malformed entry can silently zero the whole file** — a locator containing `: ` (colon-space) parses as a broken YAML mapping and the upload contains 0 dependencies with no error. After any edit, run `fossa analyze --output` (dry run) and confirm the dependency count before trusting a scan.

## 4. User-defined dependency (internal/unfetchable packages)

For packages FOSSA can never fetch (internal builds, custom kernels, private forks), create a user-defined dependency carrying the license data yourself, then ignore the unresolvable original:

```
POST /api/revisions/{REV}/dependencies
```

```json
{
  "dependencyData": {
    "kind": "new",
    "newDependency": {
      "kind": "user",
      "name": "acme-internal-crypto",
      "version": "3.1.4",
      "licenses": [
        {
          "licenseId": "GPL-2.0-only",
          "text": "…full license text…",
          "copyright": "Copyright (c) Acme",
          "url": "https://…/COPYING",
          "title": "GPL-2.0-only"
        }
      ]
    }
  }
}
```

- User-defined dependencies are **org-scoped and de-duplicated** — creating the "same" one in two projects reuses one record.
- `licenseId` is **not validated server-side** — pre-check every id against `GET /api/licenses/{id}` (expect 200) or you'll store a typo as data.
- For an internal _rebuild_ of an open-source package (e.g. a patched BSD tool), the honest license is the upstream one; put provenance in the license `url`.

## Bulk-run discipline

Same as corrections (see `license-corrections.md`): plan file with evidence → single-item test gate → append-only checkpoint (resume without double-writes) → read back every write → verify the outcome metric (unknown count, issue count) with queue-lag tolerance, not just HTTP 200s.
