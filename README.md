# fossa-skill — Claude skill for the FOSSA API

A [Claude agent skill](https://docs.claude.com/en/docs/agents-and-tools/agent-skills) that teaches Claude to drive FOSSA (app.fossa.com) through its REST API: check scans, pull and ignore issues, generate attribution reports and SBOMs, fix misidentified dependencies, correct licenses, and manage policies and release groups — the happy paths, with the real-world gotchas documented.

The skill is plain Markdown + `curl`/`jq` recipes. No runtime, no dependencies, nothing to host — your security team can read every line of what it does.

## Install

**Claude Code (CLI/IDE):** copy the `fossa/` directory into `~/.claude/skills/` (personal) or `<repo>/.claude/skills/` (per-project):

```bash
cp -r fossa ~/.claude/skills/
```

Then just ask Claude to do FOSSA things ("check if my scan finished", "generate a CycloneDX SBOM for project X") — or invoke it explicitly with `/fossa`.

**claude.ai (web/desktop):** zip the `fossa/` directory and upload it under Settings → Capabilities → Skills.

## Auth setup (one time)

1. Create a FOSSA API token: app.fossa.com → Settings → Integrations → API. Use a **full** token (push-only tokens can upload builds but cannot read issues/reports).
2. Make it available to Claude as `FOSSA_API_KEY`:

```bash
export FOSSA_API_KEY=<your token>       # e.g. in ~/.zshrc, or your CI secret store
```

The skill never asks you to paste the token into chat; recipes read it from the environment. Tokens are scoped to your user + organization.

## What's inside

```
fossa/
  SKILL.md                       # overview: auth, locators, conventions, workflow index
  references/
    scans-and-issues.md          # scan status polling, listing + ignoring issues
    reports.md                   # attribution reports, SBOMs (CycloneDX/SPDX), dependency lists
    license-corrections.md       # project corrections, license conclusions — and which one you want
    dependency-fixes.md          # re-resolve, remap wrong locators, fossa-deps, user-defined deps
    packages.md                  # package index lookup, registry probes, locator grammar
    policies-and-projects.md     # policies, project settings, release groups
```

## Status of this skill

This skill is provided informally by FOSSA folks to help you get value from FOSSA + Claude today. It is not a supported FOSSA product surface. It rides on FOSSA's existing REST API — endpoints marked **documented** in the skill are covered at [docs.fossa.com](https://docs.fossa.com/docs/api-documentation); the rest are the same stable endpoints FOSSA's own UI and CLI use, but they can change without notice. An official, supported MCP integration is on FOSSA's roadmap; this skill is the bridge until then, and the workflows it teaches will map cleanly onto that integration when it lands.

Questions, corrections, or "it would be great if it could also…" — tell your FOSSA contact.
