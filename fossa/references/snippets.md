# Snippet scanning (copied OSS code in first-party files)

Snippet analysis finds third-party open-source code copied into your own source files — the mechanism behind AI-code guardrails (AI assistants reproduce OSS snippets) and C/C++ vendored-code review. Each **snippet** is a matched OSS package; its **matches** are the first-party files/lines where that code appears.

## Prerequisites

- Snippet detection is an **entitlement** (org feature flag) — if these endpoints 403/404 for a whole org, the org likely doesn't have the add-on.
- A revision only has snippet data if the scan ran with snippet analysis: `fossa analyze --snippet-scan` (verify it ran by checking analyze output for the snippet summary line — "Unique Files with matches found: N"; debug output uses snake_case keys like `unique_matched_files`). Upload success alone does not prove the snippet stage executed.
- **"Snippet analysis does not exist for user revision: X"** is the API's normal answer for a revision that never ran a snippet scan — report it as "no snippet scan on this revision," never as "no snippets found."
- **Snippet match records materialize ASYNCHRONOUSLY after the scan.** The CLI's scan-time summary ("Unique Files with matches found: N", Bucket ID = temp storage "before processing" per the CLI docs) reports knowledge-base fingerprint hits; the queryable snippet/match records are produced by a later Sparkle-side processing stage. An empty `results` list shortly after a scan means processing hasn't finished — poll later before reporting "no snippets found" (live-verified 2026-09-09: 13/14 files matched at scan time, list endpoint still empty at T+15min on app.fossa.com).

## Endpoints (informal — same surface FOSSA's UI uses)

`{REV}` = URL-encoded revision locator.

```
GET /api/revisions/{REV}/snippets              # matched OSS packages — "?path=..." is REQUIRED (400 "expected string ... at \"path\"" without it); use "?path=/" for the whole tree, "?path=/src" for a subtree
GET /api/revisions/{REV}/snippets/paths        # file/directory tree where snippets were detected
GET /api/revisions/{REV}/snippets/{snippetId}  # one snippet incl. its matched first-party files
GET /api/revisions/{REV}/snippets/{snippetId}/matches/{url-encoded-file-path}
                                               # side-by-side: detected code vs the OSS reference
```

## Triage guidance (from production snippet rollouts)

- Match **percentage alone doesn't equal risk** — a 98% match can be legitimately rejected (e.g. generated code such as parser output), and legal teams need license + provenance context, not just the number.
- The product's numeric gate is the org/project **auto-reject match-percentage threshold** (there is no line-count floor). The main noise class in practice is imports/boilerplate-only matches — filter those in your triage layer.
- For "which files have copied GPL code" style asks: list snippets, filter by the match's license, then use the side-by-side endpoint for the evidence view.
