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
  // Every repo value funnels through here, so a model-supplied one is shape-checked once, up front.
  if (repo) return assertRepo(repo)
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

// Values that end up in a REST path or on the gh command line are shape-checked first, so a
// model-supplied string cannot traverse the path or land in gh's flag parser.
const REPO_RE = /^[\w.-]+\/[\w.-]+$/
const RUN_ID_RE = /^\d+$/
export function assertRepo(repo: string): string {
  // owner/name with no dot segments: `../repo` or `owner/..` would otherwise walk the REST path.
  if (!REPO_RE.test(repo) || repo.split('/').some(part => part === '.' || part === '..')) {
    throw new Error(`Invalid repository "${repo}": expected owner/name.`)
  }
  return repo
}
export function assertRunId(runId: string): string {
  if (!RUN_ID_RE.test(runId)) throw new Error(`Invalid run id "${runId}": expected digits.`)
  return runId
}

// The commit the PR branched from, which is what CI analyzed on the base branch.
export async function mergeBase(run: Run, repo: string, baseRef: string, headSha: string): Promise<string> {
  // Encode each part, so a branch such as release#1 survives; keep the slashes.
  const base = baseRef.split('/').map(encodeURIComponent).join('/')
  const out = await run(['api', `repos/${assertRepo(repo)}/compare/${base}...${headSha}`, '--jq', '.merge_base_commit.sha'])
  return out.trim()
}

// `fossa analyze` prints the project's dashboard link, which holds the
// project locator. Used when the locator is not the default one, for example
// when CI passes --project or the repo has a .fossa.yml.
// Only links on the configured FOSSA host count (default app.fossa.com), so a PR-controlled
// log line that mentions some other site's /projects/…/refs/ link is skipped, not adopted.
export function fossaHost(endpoint = process.env.FOSSA_ENDPOINT || 'https://app.fossa.com'): string {
  return new URL(endpoint).host.toLowerCase()
}
export async function projectFromJobLog(run: Run, repo: string, jobId: string, host = fossaHost()): Promise<string | undefined> {
  const log = await run(['api', `repos/${assertRepo(repo)}/actions/jobs/${assertRunId(jobId)}/logs`])
  for (const match of log.matchAll(/https:\/\/([^\s/]+)\/projects\/([^/\s]+)\/refs\//g)) {
    if (match[1].toLowerCase() === host) return decodeURIComponent(match[2])
  }
  return undefined
}

export async function rerunFailed(run: Run, repo: string, runId: string): Promise<void> {
  await run(['run', 'rerun', assertRunId(runId), '--failed', '-R', assertRepo(repo)])
}
