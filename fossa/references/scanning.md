# Creating scans — the five surfaces

Everything else in this skill assumes a scan exists. This is how scans get made. Five surfaces:

| Situation | Use |
|---|---|
| Package-managed source repo (CI available) | **CLI**: `fossa analyze` + `fossa test` gate |
| Many repos / no CI / SCM-connected org | **Quick Import / GitHub App** (FOSSA runs the CLI server-side) |
| Container image | **`fossa container analyze`** |
| Only an SBOM (vendor/firmware/supplier) | **SBOM import** — see `sbom-import.md` |
| Only a compiled binary (entitled orgs) | **Binary decomposition** — §5 below |

## 1. CLI `fossa analyze`

Walks the directory, discovers projects per ecosystem (30+ strategies: npm/yarn/pnpm, maven/gradle, go, pip/poetry/pipenv/uv, cargo, nuget, cocoapods/SPM, composer, bundler, sbt, …), extracts dependency graphs, uploads. Project locator becomes `custom+{orgId}/{name}`.

**Identity discipline** (worth enforcing in CI): `-p <project> -r <revision> -b <branch>` — keep `-p` stable, vary `-r` per scan. In `.fossa.yml` the locator comes from `project.id`; `project.name` is only the display title (the same slot as `-t`, honored only when the project is first created — `docs/references/files/fossa-yml.md` §`project`), and `project.locator` is read only by `fossa project edit`, never by `analyze`. With neither `-p` nor `project.id` the CLI infers the ID — the git `remote origin` URL, else the SVN repository root, else the directory name (`src/App/Fossa/ProjectInference.hs:59-75,176-214`) — and silently creates that project. `-p` overrides `project.id` only; the title still comes from `-t`/`project.name` (`src/App/Fossa/Config/Common.hs:431`, `src/App/Fossa/Config/ConfigFile.hs:183`; fossa-cli master `235aef22`). Observed 2026-11-04 on fossa-cli 3.20.4: a checkout with no git remote and only `name` set uploaded as `custom+{org}/{dirname}`. Metadata flags: `-t` title, `-T` team, `--policy`/`--policy-id`, `--project-label` (×5), `--release-group-name`/`--release-group-release`.

**Dry-run before trusting**: `--output` analyzes WITHOUT uploading (print-only); `--tee-output` does both; `--json` prints the locator for API follow-up. After editing `fossa-deps.yml`, always dry-run — one malformed entry can silently zero the upload (see `dependency-fixes.md`).

**Static vs dynamic strategies**: lockfile parsing is static; Gradle/Go-style managers need working build tooling (JDK, resolvable repos) — **a broken build env can yield ZERO dependencies with exit 0**. If the scan summary shows a project skipped or empty, that's the first suspect. `--static-only-analysis` trades completeness for not needing the build env; `--strict` refuses fallbacks. Preview what will be scanned: `fossa list-targets`.

**Default filters** skip `node_modules/`, `vendor/`, `test(s)/`, `docs/`, `examples/`, `third[-_]party/`, etc. — scope with `--only-target`/`--exclude-target`/`--only-path`/`--exclude-path`, or `--without-default-filters`.

**The three first-party-code engines** (commonly confused — distinct features):

| Flag | What it finds | Data uploaded | Notes |
|---|---|---|---|
| `--detect-vendored` | Whole vendored OSS libraries (VSI) | SHA-256 file fingerprints | ~35k-file soft limit; direct deps only |
| `--snippet-scan` | Copied OSS **snippets** in your files | Fingerprints + matched files' full content (30-day retention) | Enterprise + org enablement; incompatible with `--output`; summary line: "Unique Files with matches found: N" — match records become queryable later, sometimes never; see `references/snippets.md` |
| `--x-vendetta` | Vendored OSS, holistic (experimental) | MD5 file hashes only | Incompatible with `--output` (hard error) |

**Scoping the first-party-code engines is not the same as scoping analysis.** `paths.exclude` / `--exclude-path` filter target discovery only. `--x-vendetta` and `--snippet-scan` ignore them and honor just `vendoredDependencies.licenseScanPathFilters.exclude` globs in `.fossa.yml` (the pair `dir/*` plus `dir/**` is what was verified). Live-verified on one tree: `paths.exclude` on a vendored OpenSSL directory left OpenSSL in the vendetta results; the `licenseScanPathFilters` exclude removed it. To exclude a directory from everything, set both. (One exception, next paragraph: an archive-upload org cannot combine that filter block with `vendored-dependencies`.) Both engines report the closest match they can find, so treat a reported **version** of vendored C/C++ code as a lead and confirm it against the copy's own version header or the git submodule pin before relying on its CVE list.

**Archive-upload exception: `licenseScanPathFilters` + `vendored-dependencies` drops the whole fossa-deps unit.** It fires only when the vendored-dependency scan method resolves to `ArchiveUpload` — `vendoredDependencies.scanMethod: ArchiveUpload` / `--force-vendored-dependency-scan-method ArchiveUpload`, an org whose default is archive upload (`GET /api/cli/organization` → `defaultVendoredDependencyScanType`), or a server without CLI-side license scanning; the CLI's own default is `CLILicenseScan` (`src/Fossa/API/Types.hs:534`, `docs/references/subcommands/analyze.md` §scan method). In that configuration any `licenseScanPathFilters` block together with `vendored-dependencies` in `fossa-deps.yml` is rejected (`Path filters are not allowed when doing archive uploads`, `src/App/Fossa/ManualDeps.hs:308-309` — the `archiveOrCLI == ArchiveUpload && isJust pathFilters` guard; fossa-cli master `235aef22`), and because `toSourceUnit` fatals before building anything the **entire** fossa-deps source unit is dropped — referenced, custom, remote and locator entries included (`src/App/Fossa/Analyze.hs:466`). Every other unit still uploads and the exit code stays 0: the error is printed at `SevError` as a recovered phase failure (`Analyze.hs:371,467`) and the scan summary shows `* fossa-deps file analysis: failed`, so CI has to grep one of those. A `--output` dry-run does **not** catch it — with no API opts the vendored-dependency scan is skipped (`src/App/Fossa/Config/Common.hs:193-196`, `ManualDeps.hs:206-208`); only a real upload or `--tee-output` exercises the guard. Fix: switch the method (`vendoredDependencies.scanMethod: CLILicenseScan` or `--force-vendored-dependency-scan-method CLILicenseScan`, `docs/features/vendored-dependencies.md` §scan method), which keeps both the filters and the unit; only where the server cannot do CLI-side license scans fall back to scoping the two engines with `.gitignore`, which both honor (`src/App/Fossa/Ficus/Analyze.hs:150,452` pass `--set all:gitignore`). Observed 2026-11-04 on fossa-cli 3.20.4 against an org whose default is `ArchiveUpload`.

Plus `--detect-dynamic <binary>` (dynamically-linked deps, direct+transitive) and org-configurable first-party license scans.

**Go binaries without Go source** — `fossa analyze --enable-go-binary-analysis` (opt-in; fossa-cli `ead5701b`, ANE-3098, master `235aef22`; `src/App/Fossa/Config/Analyze.hs:246, 316, 417-423`, `docs/references/subcommands/analyze.md:141`, `docs/references/strategies/languages/golang/gobinary.md`). It walks the tree for ELF/Mach-O/PE files of at least 4 KiB, reads the module list the Go linker embedded (what `go version -m <binary>` prints) and reports each module as a **direct `go+` dependency with no edges** (flat graph); binaries in one directory become one project. Pair it with `--unpack-archives` to reach binaries inside AARs/JARs; default path filters still apply (a binary under `vendor/` is skipped without `--without-default-filters`). It can't see binaries built before Go 1.18 or without module info (GOPATH-mode, CGO-only objects), and the main module is skipped when its version is `(devel)`. The toolchain is not invoked and the binary is not executed. It is an analysis strategy whose output is a dependency graph (documented under `docs/references/strategies/`), not one of the first-party-code engines above.

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

- OS packages: apk/dpkg/rpm databases. App deps: **static-only** strategies found in the image filesystem — Gradle/Cargo (dynamic-only) will NOT appear from a container scan, and `fossa-deps.yml` inside the image is ignored.
- **Go binaries ARE detected (CLI ≥ 3.18.0 — pending release as of 2026-08-20)**: the analyzer inspects executables in every layer and reads the module list embedded in Go ≥ 1.18 binaries (what `go version -m` shows), reporting them as regular Go dependencies — so Go deps surface even from `scratch`/distroless/Chainguard images with no package metadata. Pseudo-versions normalize to commit hashes exactly like a go.mod scan; binaries built before Go 1.18 (or with build info stripped/packed) are skipped (`--debug` lists which). Note `go.mod`/`go.sum` files inside the image are still ignored — container Go deps come exclusively from binary buildinfo. **No CLI-side opt-out**: Go-binary results (like JAR observations) are appended outside the target-filter path, so neither `.fossa.yml` target filtering nor `--only-system-deps` suppresses them.
- Reliable pattern for other compiled apps (and Go < 1.18): `fossa analyze` on source in CI **plus** `fossa container analyze` on the image, combined in a release group.
- Gate with `fossa container test <image>`; `--only-system-deps`, `-o` dry-run, `.fossa.yml` target filtering, `fossa container list-targets` all work — with the caveat above: none of these filter out Go-binary/JAR results.

## 4. SBOM import — see `sbom-import.md` for the full contract and verified API sequence.

## 5. Binary decomposition (entitled orgs)

Upload a compiled binary or an archive of binaries and FOSSA's binary analysis identifies the open-source components inside it. It is entitlement-gated and **metered**: each upload draws down a contracted number of decompositions, so confirm with the user before uploading, and never loop uploads.

Same three calls as SBOM import, with `fileType=binary`:

```bash
SIGNED=$(curl -s -H "Authorization: Bearer $FOSSA_API_KEY" \
  "https://app.fossa.com/api/components/signed_url?packageSpec={NAME}&revision={REV}&fileType=binary" | jq -r .signedUrl)
curl -s -X PUT -H "Content-Type: binary/octet-stream" --data-binary @firmware.bin "$SIGNED"
curl -s -X POST -H "Authorization: Bearer $FOSSA_API_KEY" -H "Content-Type: application/json" \
  "https://app.fossa.com/api/components/build?fileType=binary" \
  -d '{"archives":[{"packageSpec":"{NAME}","revision":"{REV}"}],"forceRebuild":false}'   # → 201
```

- The `signed_url` call is the entitlement check, before anything is consumed: `403 Requires archiveAndLicenseUpload feature flag and premium access level.`, `403 Outside of binary decomposition billing term. Contact support.`, or `403 You are out of binary decompositions. Contact support to increase your limit.` Since FOSSA `d7ac5a3133` (develop 2026-10-27; code at `b51a25a5a1`) it is also the **permission** check: `403 You are not permitted to upload to this project.` when the token may not upload to the project the `packageSpec`/`revision` would land in — an existing project needs Project **Edit** on it, a new one needs Project **Create** in some scope (for archive/binary uploads, which may be dependencies, Edit-anywhere also qualifies) — `routes/components.ts:128-139`, `modules/ProjectManager/index.ts:270-311`. The `/api/components/build` route no longer carries a blanket project-create gate (`routes/components.ts:50-53`), so an Edit-only user can re-upload to a project that already exists (passing a `team` additionally needs permission to create in, or add projects to, those teams — 403 `You are not permitted to add a project to the selected teams.`, `modules/fileUploadHandler.ts:146-151`).
- The project locator is `binary+{orgId}/{NAME}` and the revision locator is `binary+{orgId}/{NAME}${REV}`. The reads take that **full, URL-encoded revision locator**, not the bare `{REV}` used in the upload calls: poll `GET /api/cli/$(enc "binary+{orgId}/{NAME}\${REV}")/latest_build`, then read `GET /api/v2/revisions/{REV-locator}/dependencies`. A bare revision 404s (`Revision for locator (…) was not found`); that is a wrong URL, not a failed upload, so fix the URL and do not upload again. Identified components come back as `csbinary+{vendor}/{product}${version}` locators with licenses attached. Vulnerability issues come from the binary analyzer's own findings, so they can be absent for a component whose version plainly has CVEs (observed: `csbinary+openssl/openssl$3.1.3` with none) — an empty list here is not a clean bill.
- Know what it can see. It identifies components in the file formats it can open; it does **not** unpack UEFI/BIOS firmware volumes. Live-verified on a UEFI image built with OpenSSL 3.5.7: the raw image returned one component and no OpenSSL (the payload is a single LZMA stream); the same image unpacked into its PE32 modules returned OpenSSL, at the wrong version. For firmware built from source, a source-side SBOM (`sbom-import.md`) is the accurate route.
