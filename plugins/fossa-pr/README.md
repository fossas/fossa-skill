# fossa-pr

See the FOSSA issues on a GitHub pull request, then fix, ignore, or hand each one to fossabot, without opening the FOSSA web app.

One folder is a plugin for both Claude Code and Codex:

| Part | Claude Code | Codex |
| :- | :- | :- |
| Local MCP server (`mcp/server.ts`): 5 tools | Yes | Yes |
| Skill (`skills/fossa-triage`): how to triage | Yes | Yes |
| UI | A pane with buttons, from the mod (`hooks/register.tsx`) | A widget in Codex Desktop (`mcp/widget.html`, MCP Apps) |
| Alert when the FOSSA check fails | Toast and status line (polls GitHub every 60 s) | One line of context at session start (`codex/hooks.json`) |

## What it does

For a PR, it reads the issues FOSSA found on the head commit, and marks each one as **new** (the PR brought it in) or **on base** (it was already on the base branch). For each issue you can:

- **Fix**: Claude or Codex upgrades the dependency and shows the diff.
- **Explain**: the agent reads the issue details and says whether the code uses the affected part.
- **Ignore**: with a reason and a note, which FOSSA records. You confirm first.
- **fossabot PR**: ask fossabot for an upgrade PR. You confirm first. The button shows only where Core would accept the request: a dependency vulnerability in npm, mvn or pip, with a fix version, in an org with fossabot upgrade PRs on and the repo connected with credits left. Otherwise the pane gives the reason in one line.
- **Rerun check**: rerun the failed GitHub Actions jobs.

## Set up

Needs Node 22.18 or later, `gh` logged in, and a **full-access** FOSSA API key. A push-only CI key can count issues but cannot read them.

```sh
mkdir -p ~/.config/fossa-pr
printf '%s' 'YOUR_KEY' > ~/.config/fossa-pr/api-key
chmod 600 ~/.config/fossa-pr/api-key
```

`FOSSA_API_KEY` in the environment works too, and wins over the file. Codex does not pass most environment variables to MCP servers, so use the file there. `FOSSA_ENDPOINT` sets another FOSSA host (default `https://app.fossa.com`).

### Claude Code

```sh
claude plugin marketplace add fossas/fossa-skill
claude plugin install fossa-pr@fossa
```

Then run `/fossa-pr` on a branch with a PR, `/fossa-pr 166`, or `/fossa-pr owner/repo#166` from any directory. The pane also opens when Claude calls `fossa_pr_issues` itself, for example after "show the FOSSA issues on this PR". The pane takes the keyboard: Tab moves between buttons, Enter presses one, and Esc goes back to the prompt. Mods need Claude Code 2.1.287 or later.

In auto mode, allow the two read-only tools, so that the pane can load without a question each time:

```json
"permissions": { "allow": ["mcp__plugin_fossa-pr_fossa__fossa_pr_issues", "mcp__plugin_fossa-pr_fossa__fossa_issue"] }
```

### Codex

```sh
codex plugin marketplace add fossas/fossa-skill
codex plugin add fossa-pr@fossa
```

Then ask "show the FOSSA issues on this PR". The widget needs Codex Desktop 26.616 or later with `features.apps` and `features.enable_mcp_apps` on. Without them, Codex shows the issues as text.

## Easy on FOSSA's API

The server is the only part that calls FOSSA, and it:

- sends at most 1 request per second, and at most 2 at a time
- caches each answer for 10 minutes, and the org ID for the whole session
- shares one request between callers who ask for the same thing at once
- waits 3, 6, then 12 seconds while a scan runs, then stops and says so
- follows `Retry-After` on a 429, retries a 502–504 twice, and never retries anything else
- clears the project's cache after an ignore

The watch in Claude Code and the Codex hook call GitHub only.

The first look at a PR usually costs 3 FOSSA requests: the org ID, the head commit's issues, and the base commit's issues (shared by every PR on the same base commit). A scan that is still running adds up to 3 more, and the CI-log fallback adds 1. Another look within 10 minutes costs none.

## How it finds the project

CI's default FOSSA project for a GitHub repo is `custom+<org id>/github.com/<owner>/<repo>`. When that project has no analysis of the commit, the server reads the project from the FOSSA link that `fossa analyze` printed in the CI job log, so a custom `--project` or `.fossa.yml` works too.

## Layout

```
.claude-plugin/plugin.json    Claude Code manifest (starts the MCP server)
plugin.json                   Codex manifest (Agent Plugins format)
mcp.json                      Codex: starts the MCP server
mcp/server.ts                 stdio JSON-RPC, no dependencies
mcp/fossa.ts                  FOSSA client: pacing, cache, retries
mcp/github.ts                 gh calls
mcp/tools.ts                  the 5 tools
mcp/check.ts                  finds the FOSSA check in a PR's checks (shared with the mod)
mcp/widget.html               Codex widget (MCP Apps)
mcp/session-start.ts          Codex SessionStart hook
codex/hooks.json
hooks/register.tsx            Claude Code mod: pane, toast, buttons
types/index.d.ts              shared types and the mod's state contract
skills/fossa-triage/SKILL.md  shared by both
```

The marketplace files that list this plugin are at the root of the fossa-skill repository.

## Develop

```sh
claude --plugin-dir ./plugins/fossa-pr     # load this folder for one session
```

## Test

```sh
(cd mcp && npm test)        # server: 28 tests, fake FOSSA and fake clock
claude plugin test .        # mod: 13 tests against the Claude Code engine
claude plugin validate ./.claude-plugin/plugin.json
```

## Known limits

- An ignore applies to the whole FOSSA project, for every revision, not only to the PR.
- The Codex widget needs Codex Desktop with `features.apps` and `features.enable_mcp_apps` on. Without them Codex shows the issues as text.
- The Claude Code pane takes clicks only in the fullscreen layout (`"tui": "fullscreen"`). In the normal layout, use ctrl+x tab, then Tab and Enter.
