// GitHub through the `gh` CLI, with the user's own login. Nothing here calls FOSSA.

import { execFile } from 'node:child_process'

import type { FossaCheck } from '../types/index.d.ts'
import { fossaCheckOf } from './check.ts'

export type Run = (args: string[], opts?: { cwd?: string }) => Promise<string>

export const runGh: Run = (args, opts = {}) =>
  new Promise((resolve, reject) => {
    execFile('gh', args, { cwd: opts.cwd, timeout: 30_000, maxBuffer: 32 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error(`gh ${args.slice(0, 3).join(' ')} failed: ${(stderr || err.message).trim()}`))
      else resolve(stdout)
    })
  })

export type PullRequest = {
  repo: string
  number: number
  title: string
  url: string
  headRef: string
  headSha: string
  baseRef: string
  fossaCheck?: FossaCheck
}

// The server runs where its host starts it: the project in Claude Code, the
// plugin's own folder in Codex. Without `repo` and `pr` it can only guess from there.
const PASS_THEM = 'Pass repo (owner/name) and pr: this server runs in'

export async function resolveRepo(run: Run, repo: string | undefined, cwd: string): Promise<string> {
  if (repo) return repo
  try {
    return (await run(['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner'], { cwd })).trim()
  } catch (err) {
    throw new Error(`${PASS_THEM} ${cwd}, which is not a GitHub repository. (${(err as Error).message})`)
  }
}

export async function pullRequest(run: Run, repo: string, pr: number | undefined, cwd: string): Promise<PullRequest> {
  const fields = 'number,title,url,headRefName,headRefOid,baseRefName,statusCheckRollup'
  // Without a number, gh finds the PR of the branch checked out in cwd.
  const args = pr === undefined ? ['pr', 'view', '--json', fields] : ['pr', 'view', String(pr), '-R', repo, '--json', fields]
  let raw
  try {
    raw = JSON.parse(await run(args, { cwd }))
  } catch (err) {
    if (pr !== undefined) throw err
    throw new Error(`${PASS_THEM} ${cwd}, where no branch has a pull request. (${(err as Error).message})`)
  }
  return {
    repo,
    number: raw.number,
    title: raw.title,
    url: raw.url,
    headRef: raw.headRefName,
    headSha: raw.headRefOid,
    baseRef: raw.baseRefName,
    fossaCheck: fossaCheckOf(raw.statusCheckRollup ?? []),
  }
}

// The commit the PR branched from, which is what CI analyzed on the base branch.
export async function mergeBase(run: Run, repo: string, baseRef: string, headSha: string): Promise<string> {
  const out = await run(['api', `repos/${repo}/compare/${baseRef}...${headSha}`, '--jq', '.merge_base_commit.sha'])
  return out.trim()
}

// `fossa analyze` prints the project's dashboard link, which holds the
// project locator. Used when the locator is not the default one, for example
// when CI passes --project or the repo has a .fossa.yml.
export async function projectFromJobLog(run: Run, repo: string, jobId: string): Promise<string | undefined> {
  const log = await run(['api', `repos/${repo}/actions/jobs/${jobId}/logs`])
  const match = log.match(/https:\/\/[^\s/]+\/projects\/([^/\s]+)\/refs\//)
  return match?.[1] ? decodeURIComponent(match[1]) : undefined
}

export async function rerunFailed(run: Run, repo: string, runId: string): Promise<void> {
  await run(['run', 'rerun', runId, '--failed', '-R', repo])
}
