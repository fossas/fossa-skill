---
name: fossa-triage
description: Triage the FOSSA issues on a GitHub pull request, for example when the FOSSA CI check (check-fossa) fails. Lists the issues, tells new ones from ones already on the base branch, and fixes, ignores, or hands each one to fossabot. Use when the user mentions FOSSA, a failing FOSSA check, or license or vulnerability issues on a PR.
---

# FOSSA issues on a PR

The `fossa` MCP server of this plugin has the tools. It paces and caches every call to FOSSA, so call the tools freely, but do not call `fossa_pr_issues` in a loop to wait for a scan.

## Steps

1. Call `fossa_pr_issues`. Pass `repo` (owner/name) and `pr` when you know them; leave them out to use the current directory's repository and branch.
2. Show the result as a short table: package and version, issue type, CVE or license, severity, fixed-in version, and new or on base. Put the new issues first: the PR brought them in. An issue that is on base was already on the base branch and is not this PR's fault.
3. For each issue, recommend one action, with a one-line reason:
   - **Fix**: upgrade the dependency to the `fixedIn` version, run the tests, and show the diff. Do not commit or push without the user's yes.
   - **Ignore**: when the issue does not apply (the vulnerable code is not used, the data is wrong) or the user decides to accept it. Call `fossa_issue` first when you need the details to decide; pass the `headSha` from step 1 as `revision`.
   - **fossabot PR**: for a vulnerability whose fix is a plain version upgrade that the user wants done in its own PR.
4. Before `fossa_ignore_issue` or `fossa_request_fix_pr`, ask the user and wait for a yes. Both change FOSSA for the whole project.
5. After the last fix or ignore, offer `fossa_rerun_check` with the `check.runId` from step 1.

## Ignore reasons

`fossa_ignore_issue` takes `notes` (always: who decided and why) and an optional `reason`:

| Situation | reason |
| :- | :- |
| The vulnerable function is never called | `Vulnerable_code_not_in_execute_path` |
| The vulnerable code is not in the version we use | `Vulnerable_code_not_present` |
| The package is not shipped or not present | `Component_not_present` |
| FOSSA matched the wrong package or license | `incorrect_data_found` |
| Someone is still looking at it | `Under_investigation` |
| None of the above | `other` |

For a licensing or quality issue, leave `reason` out unless the data is wrong.

## When a tool fails

- `No FOSSA API key`: ask the user to set `FOSSA_API_KEY` to a full-access key, or to put one in `~/.config/fossa-pr/api-key`. A push-only CI key cannot read issue details.
- `status: waiting`: FOSSA is still scanning. Say so and stop; do not retry right away.
- `status: not-analyzed`: CI did not upload this commit to FOSSA. Check that CI runs `fossa analyze` on this branch.
- `newCount` is absent: FOSSA has no scan of the base commit, so new and old issues are not told apart. Say so.
