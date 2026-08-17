---
name: fossa
description: Work with FOSSA (app.fossa.com) via its REST API — check whether a scan/analysis finished, list and ignore issues, generate attribution reports and SBOMs (CycloneDX/SPDX), list dependencies, fix misidentified or unresolved dependencies, correct licenses and copyrights, conclude licenses, look up packages in FOSSA's registry, and manage policies, projects, and release groups. Use whenever the user mentions FOSSA, fossa-deps, a FOSSA project/scan/issue/report, or license compliance tasks on app.fossa.com.
---

# FOSSA API skill

FOSSA scans software projects for open-source license compliance and vulnerabilities. This skill covers driving it through its REST API: the happy paths, with the gotchas that cost real users real time documented inline. All recipes are `curl` + `jq`.

## Setup (once per session)

- Base URL: `https://app.fossa.com/api`
- Auth header on every call: `Authorization: Bearer $FOSSA_API_KEY`
- The token must be a **full** token (push-only tokens can upload builds but can't read issues/reports). Tokens are scoped to the user's **currently active organization** — a valid token 404s on another org's resources.
- If `FOSSA_API_KEY` isn't set, ask the user to export it (app.fossa.com → Settings → Integrations → API). Never ask them to paste the token into the conversation.

```bash
# sanity check — should return a JSON array of projects
curl -s -H "Authorization: Bearer $FOSSA_API_KEY" "https://app.fossa.com/api/projects?count=1&page=1" | jq '.[0].locator'
# token scope check — "FullAccess" is what you want; "Push" can't read issues/reports
curl -s -H "Authorization: Bearer $FOSSA_API_KEY" "https://app.fossa.com/api/cli/token_type" | jq -r .tokenType
```

## Locators (read `references/packages.md` before constructing one)

Everything keys off **locators**: `{fetcher}+{package}${revision}` (e.g. `mvn+junit:junit$4.13.2`, `custom+1234/my-service$main`). **Always URL-encode locators in URL paths** (`+`→`%2B`, `/`→`%2F`, `$`→`%24`, `:`→`%3A`, `#`→`%23`):

```bash
enc() { jq -rn --arg v "$1" '$v|@uri'; }
```

## Workflow index — read the matching reference before acting

| You want to…                                                                    | Read                                  |
| ------------------------------------------------------------------------------- | ------------------------------------- |
| Check a scan/analysis finished; list, filter, or ignore issues                  | `references/scans-and-issues.md`      |
| Generate an attribution report, SBOM, or notices file; list dependencies        | `references/reports.md`               |
| Fix a wrong license/copyright on a dependency; conclude a license               | `references/license-corrections.md`   |
| Fix an unresolved/misidentified dependency; author fossa-deps; add a custom dep | `references/dependency-fixes.md`      |
| Look up a package/coordinate in FOSSA's registry; locator grammar               | `references/packages.md`              |
| Read or update policies; project settings; release groups                       | `references/policies-and-projects.md` |

## Ground rules (apply to every workflow)

1. **Read before write.** Fetch the current state of anything you're about to mutate; confirm the target with the user if there's any ambiguity about which project/org you're operating on.
2. **Read back after write.** An HTTP 200 is not verification — re-fetch and confirm the change landed as intended. Each reference names the exact read-back endpoint for its writes.
3. **Paginate.** List endpoints cap the page size server-side regardless of what you request (100 on the dependencies list, up to 1000 elsewhere) — always loop pages until you've collected `total`; never trust one page to be the full set.
4. **Be patient with async.** Report generation and issue rescans run on queues (30s–70min depending on the operation). Poll; don't declare failure on the first empty result. Each reference states the expected latency.
5. **Bulk writes need a plan file, a one-item test gate, and an append-only checkpoint** — run one, read it back, then run the rest, logging each completion so an interrupted run resumes without double-writing. Details in `references/license-corrections.md`.
6. **Destructive or org-visible actions** (ignoring issues, overwriting dependencies, editing policies) — state what you're about to change and how many items it touches BEFORE doing it, and prefer a single-item trial when the user's ask is bulk.

## Endpoint stability

Endpoints marked **documented** in the references have official coverage at [docs.fossa.com](https://docs.fossa.com/docs/api-documentation). The rest are the same stable endpoints FOSSA's own web UI and CLI use — they work today and have for years, but aren't part of the published API contract and can change without notice.
