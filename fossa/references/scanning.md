# Creating scans — the four surfaces

Everything else in this skill assumes a scan exists. This is how scans get made. Four surfaces:

| Situation | Use |
|---|---|
| Package-managed source repo (CI available) | **CLI**: `fossa analyze` + `fossa test` gate |
| Many repos / no CI / SCM-connected org | **Quick Import / GitHub App** (FOSSA runs the CLI server-side) |
| Container image | **`fossa container analyze`** |
| Only an SBOM (vendor/firmware/supplier) | **SBOM import** — see `sbom-import.md` |

## 1. CLI `fossa analyze`

Walks the directory, discovers projects per ecosystem (30+ strategies: npm/yarn/pnpm, maven/gradle, go, pip/poetry/pipenv/uv, cargo, nuget, cocoapods/SPM, composer, bundler, sbt, …), extracts dependency graphs, uploads. Project locator becomes `custom+{orgId}/{name}`.

**Identity discipline** (worth enforcing in CI): `-p <project> -r <revision> -b <branch>` — keep `-p` stable, vary `-r` per scan. Metadata flags: `-t` title, `-T` team, `--policy`/`--policy-id`, `--project-label` (×5), `--release-group-name`/`--release-group-release`.

**Dry-run before trusting**: `--output` analyzes WITHOUT uploading (print-only); `--tee-output` does both; `--json` prints the locator for API follow-up. After editing `fossa-deps.yml`, always dry-run — one malformed entry can silently zero the upload (see `dependency-fixes.md`).

**Static vs dynamic strategies**: lockfile parsing is static; Gradle/Go-style managers need working build tooling (JDK, resolvable repos) — **a broken build env can yield ZERO dependencies with exit 0**. If the scan summary shows a project skipped or empty, that's the first suspect. `--static-only-analysis` trades completeness for not needing the build env; `--strict` refuses fallbacks. Preview what will be scanned: `fossa list-targets`.

**Default filters** skip `node_modules/`, `vendor/`, `test(s)/`, `docs/`, `examples/`, `third[-_]party/`, etc. — scope with `--only-target`/`--exclude-target`/`--only-path`/`--exclude-path`, or `--without-default-filters`.

**The three first-party-code engines** (commonly confused — distinct features):

| Flag | What it finds | Data uploaded | Notes |
|---|---|---|---|
| `--detect-vendored` | Whole vendored OSS libraries (VSI) | SHA-256 file fingerprints | ~35k-file soft limit; direct deps only |
| `--snippet-scan` | Copied OSS **snippets** in your files | Fingerprints + matched files' full content (30-day retention) | Enterprise + org enablement; summary line: "Unique Files with matches found: N" |
| `--x-vendetta` | Vendored OSS, holistic (experimental) | MD5 file hashes only | Incompatible with `--output` (hard error) |

Plus `--detect-dynamic <binary>` (dynamically-linked deps, direct+transitive) and org-configurable first-party license scans.

**`fossa-deps.yml`** — four sections: `referenced-dependencies` (registry lookup by type/name/version — see `dependency-fixes.md` for schema traps), `custom-dependencies` (declare unscannable code + license), `remote-dependencies` (FOSSA downloads + license-scans an archive URL), `vendored-dependencies` (local dir/file archived + license-scanned; name+version cached **org-wide** — first scan wins; force with `--force-vendored-dependency-rescans`).

**CI gating**: `fossa test` blocks until the issue scan finishes (default timeout 3600s; `--timeout`), exit 1 with issues on stderr, `--format json` for machines, `--diff <rev>` = only issues new vs that revision. Non-blocking alternative: `fossa analyze --json` → poll the API (see `scans-and-issues.md`).

## 2. Quick Import / GitHub App (the no-CLI path)

FOSSA-side imports run **the same fossa-cli engine on FOSSA-hosted infra** against a clone of your repo — same strategies, same results, no CI wiring. Repos connect via the GitHub App (webhooks auto-configured: pushes trigger rescans).

API surface (informal; the UI's own route):

```
POST /api/services/{service}/import        # service: github, github-app, ...
```

Body: `repos[]` (locator, branch, clone URLs, isPrivate), `filterValue` (GitHub App installation id when service=github-app), `options`: teams, policy assignment, badge PR, and — where the org is entitled — `quickImportSnippetDetectionEnabled` / `quickImportVendoredDetectionEnabled` (snippet + vendored detection on hosted scans; silently stripped if the org lacks the flags). Large repo lists queue as a background bulk import.

What you can't control here: per-scan CLI flags beyond those options (no target/path filters in the import contract). Re-scan on demand: `GET /api/revisions/{REV}/rebuild` (project Edit; `?action=dependencies` re-resolves every dependency).

## 3. Container images

`fossa container analyze <image>` — image from docker archive tar, Docker/Podman daemon, or OCI registry (digest pinning supported). Scans the **base layer, then remaining layers squashed**, tagging findings by layer — policies can suppress base-image-inherited issues separately from app-introduced ones.

- OS packages: apk/dpkg/rpm databases. App deps: **static-only** strategies found in the image filesystem — Gradle/Go-modules/Cargo (dynamic-only) will NOT appear from a container scan, and `fossa-deps.yml` inside the image is ignored.
- Reliable pattern for compiled apps: `fossa analyze` on source in CI **plus** `fossa container analyze` on the image, combined in a release group.
- Gate with `fossa container test <image>`; `--only-system-deps`, `-o` dry-run, `.fossa.yml` target filtering, `fossa container list-targets` all work.

## 4. SBOM import — see `sbom-import.md` for the full contract and verified API sequence.
