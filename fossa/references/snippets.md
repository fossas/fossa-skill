# Snippet scanning (copied OSS code in first-party files)

Snippet analysis finds third-party open-source code copied into your own source files — the mechanism behind AI-code guardrails (AI assistants reproduce OSS snippets) and C/C++ vendored-code review. Each **snippet** is a matched OSS package; its **matches** are the first-party files/lines where that code appears.

## Prerequisites

- Snippet detection is an **entitlement** (org feature flag) — if these endpoints 403/404 for a whole org, the org likely doesn't have the add-on.
- A revision only has snippet data if the scan ran with snippet analysis: `fossa analyze --snippet-scan` (verify it ran by checking analyze output for the snippet summary line — "Unique Files with matches found: N"; debug output uses snake_case keys like `unique_matched_files`). Upload success alone does not prove the snippet stage executed.
- **"Snippet analysis does not exist for user revision: X"** is the API's normal answer for a revision that never ran a snippet scan — report it as "no snippet scan on this revision," never as "no snippets found."

## Endpoints (informal — same surface FOSSA's UI uses)

`{REV}` = URL-encoded revision locator.

```
GET /api/revisions/{REV}/snippets              # snippet records (one per matched OSS package, with its match count) — "?path=..." is REQUIRED (400 "expected string ... at \"path\"" without it; raw JSON body, `jq -r .message` drops the backslashes); use "?path=/" for the whole tree, "?path=/src" for a subtree
GET /api/revisions/{REV}/snippets/packages     # the UI's packages view (rolled up per OSS package); "?path=..." REQUIRED here too. /snippets/count and /snippets/retention/metadata also exist (routes/snippets/index.ts); not described here yet
GET /api/revisions/{REV}/snippets/paths        # file/directory tree where snippets were detected
GET /api/revisions/{REV}/snippets/{snippetId}  # one snippet incl. its matched first-party files
GET /api/revisions/{REV}/snippets/{snippetId}/matches/{url-encoded-file-path}
                                               # side-by-side: detected code vs the OSS reference
```

## Triage guidance (from production snippet rollouts)

- **Snippet match records appear after the scan, not with it — and sometimes never.** The CLI's scan-time summary ("Unique Files with matches found: N") reports fingerprint match hits; the queryable records are created while Core processes the revision's build (`modules/SnippetManager/README.md` §Data Flow and §Builds, FOSSA develop `5a248a1963`: the build carries `analysisSnippetId`, Core records the analysis, asks Sparkle for the snippet PURLs, converts and resolves them to locators — both steps can fail — and only then are the snippet revisions known). Observed timing (IRIS-271 environment certification, 2026-09-09, terminal states at T+4 d): previously-matched corpora ≈ minutes; content fresh to the environment's Ficus instance ≈ 1 h; whole-tree new-to-KB content may **never** materialize (a zlib fixture: 0 records at T+4 d on both app.fossa.com and a private SaaS; the same revision still returned `totalCount: 0` on 2026-10-28, T+49 d). So an empty `results` list **can** mean processing has not finished, but not only that: matches whose PURL never resolved to a locator are never returned by this route (`includeUnresolvedSnippets` is not accepted by `routes/snippets/validators.ts`; only the build path sets it, `modules/DependencyManager/setDeepDependencies.ts:412`), and the project's hidden-snippet URLs and auto-reject match-percentage threshold also remove rows (`modules/SnippetManager/index.ts:335-354`, README §Auto-Rejecting Snippets). **Polling rule**: list payloads are cached for 15 minutes per filter set, empty results included (`modules/SnippetManager/cache.ts:16`, README §Caching) — repeat a read no more often than that, or change a cached filter key; stop once the revision's build is `SUCCEEDED` (`scans-and-issues.md`) and about an hour has passed, then report "scan complete; no queryable snippet records (new-to-KB content may never produce them)", never "pending". Validate an environment's snippet pipeline with a previously-matched corpus, not with fresh content.
- Match **percentage alone doesn't equal risk** — a 98% match can be legitimately rejected (e.g. generated code such as parser output), and legal teams need license + provenance context, not just the number.
- The product's numeric gate is the org/project **auto-reject match-percentage threshold** (there is no line-count floor). The main noise class in practice is imports/boilerplate-only matches — filter those in your triage layer.
- For "which files have copied GPL code" style asks: list snippets, filter by the match's license, then use the side-by-side endpoint for the evidence view.
