// The MCP tools. Each handler returns text for the model and, where a UI draws
// the result, structuredContent for the Claude Code mod and the Codex widget.

import { IGNORE_REASONS, FossaApiError, categoryOf, parseLocator } from './fossa.ts'
import type { Category, Issue, PrReport } from '../types/index.d.ts'
import type { CliIssue, FossaClient, IgnoreReason, IssuesResult } from './fossa.ts'
import { mergeBase, projectFromJobLog, pullRequest, rerunFailed, resolveRepo } from './github.ts'
import type { Run } from './github.ts'

export const WIDGET_URI = 'ui://fossa-pr/issues.html'
export const REPORT_URI = 'fossa-pr://report'

type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'resource'; resource: { uri: string; mimeType: string; text: string } }

export type ToolResult = {
  content: ContentBlock[]
  structuredContent?: Record<string, unknown>
  isError?: boolean
}

export type Deps = {
  fossa: () => FossaClient
  gh: Run
  cwd: string
}

type ToolDef = {
  name: string
  title: string
  description: string
  inputSchema: Record<string, unknown>
  outputSchema?: Record<string, unknown>
  annotations: Record<string, boolean>
  _meta?: Record<string, unknown>
  handle: (deps: Deps, args: Record<string, unknown>) => Promise<ToolResult>
}

const repoArg = {
  type: 'string',
  description: 'The GitHub repository as owner/name, for example acme/api. Leave out to use the repository of the current directory.',
}

const ui = { ui: { resourceUri: WIDGET_URI } }

export const TOOLS: ToolDef[] = [
  {
    name: 'fossa_pr_issues',
    title: 'FOSSA issues on a pull request',
    description:
      'List the FOSSA issues on a GitHub pull request: the issues FOSSA found on the PR head commit, each marked as new (the PR brought it in) or already on the base branch, with the state of the FOSSA CI check. Call this first; the other fossa_ tools take the issue ids and projectLocator it returns.',
    inputSchema: {
      type: 'object',
      properties: {
        repo: repoArg,
        pr: { type: 'integer', description: 'The pull request number. Leave out to use the PR of the current branch.' },
      },
    },
    // Declared so that hosts pass structuredContent on to the Claude Code mod and the Codex widget.
    outputSchema: {
      type: 'object',
      properties: {
        repo: { type: 'string' },
        pr: { type: 'integer' },
        title: { type: 'string' },
        url: { type: 'string' },
        headSha: { type: 'string' },
        baseSha: { type: 'string' },
        projectLocator: { type: 'string' },
        status: { type: 'string', enum: ['scanned', 'waiting', 'not-analyzed'] },
        check: { type: 'object' },
        newCount: { type: 'integer' },
        issues: {
          type: 'array',
          items: {
            type: 'object',
            properties: { id: { type: 'integer' }, type: { type: 'string' }, category: { type: 'string' }, package: { type: 'string' } },
            required: ['id', 'type', 'category', 'package'],
          },
        },
      },
      required: ['repo', 'pr', 'title', 'url', 'headSha', 'projectLocator', 'status', 'issues'],
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
    _meta: ui,
    handle: async (deps, args) => {
      const report = await prReport(deps, str(args.repo), int(args.pr))
      return {
        content: [
          { type: 'text', text: describeReport(report) },
          // Also as an embedded resource, for hosts that pass content blocks
          // but not structuredContent on (the Claude Code mod's $.mcp.call).
          { type: 'resource', resource: { uri: REPORT_URI, mimeType: 'application/json', text: JSON.stringify(report) } },
        ],
        structuredContent: report,
      }
    },
  },
  {
    name: 'fossa_issue',
    title: 'FOSSA issue details',
    description:
      'Get the full details of one FOSSA issue: description, affected versions, remediation, and history. Use it to explain an issue or to decide between a fix and an ignore.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'integer', description: 'The issue id from fossa_pr_issues.' },
        category: { type: 'string', enum: ['vulnerability', 'licensing', 'quality'] },
        projectLocator: { type: 'string', description: 'The projectLocator from fossa_pr_issues.' },
        revision: { type: 'string', description: 'The headSha from fossa_pr_issues: FOSSA finds an issue only within a scanned commit.' },
      },
      required: ['id', 'category', 'projectLocator', 'revision'],
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
    handle: async (deps, args) => {
      const detail = await deps
        .fossa()
        .issue(need(int(args.id), 'id'), category(args.category), need(str(args.projectLocator), 'projectLocator'), need(str(args.revision), 'revision'))
      const text = JSON.stringify(detail, null, 2)
      return { content: [{ type: 'text', text: text.length > 20_000 ? text.slice(0, 20_000) + '\n…(cut)' : text }] }
    },
  },
  {
    name: 'fossa_ignore_issue',
    title: 'Ignore a FOSSA issue',
    description:
      'Ignore a FOSSA issue in the project, for every revision, with a reason and notes that FOSSA records. Ask the user before you call this, and only call it when the issue does not apply or cannot be fixed now. The FOSSA check passes on its next run when no other issue is left.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'integer' },
        category: { type: 'string', enum: ['vulnerability', 'licensing', 'quality'] },
        projectLocator: { type: 'string' },
        reason: {
          type: 'string',
          enum: [...IGNORE_REASONS],
          description: 'Why the issue is ignored. For a vulnerability, every value but Fixed and Under_investigation maps to the VEX status Not Affected.',
        },
        notes: { type: 'string', description: 'Who decided and why, in one or two sentences. FOSSA shows it next to the ignore.' },
      },
      required: ['id', 'category', 'projectLocator', 'notes'],
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    handle: async (deps, args) => {
      const reason = str(args.reason)
      if (reason !== undefined && !(IGNORE_REASONS as readonly string[]).includes(reason)) {
        throw new Error(`reason must be one of: ${IGNORE_REASONS.join(', ')}`)
      }
      const id = need(int(args.id), 'id')
      await deps.fossa().ignoreIssue({
        id,
        category: category(args.category),
        projectLocator: need(str(args.projectLocator), 'projectLocator'),
        reason: reason as IgnoreReason | undefined,
        notes: need(str(args.notes), 'notes'),
      })
      return { content: [{ type: 'text', text: `Ignored FOSSA issue ${id}. Rerun the FOSSA check to see it pass.` }] }
    },
  },
  {
    name: 'fossa_request_fix_pr',
    title: 'Ask fossabot for an upgrade PR',
    description:
      'Ask fossabot to open a pull request that upgrades the dependency of a FOSSA issue to a safe version. Ask the user first. Needs fossabot on the organization.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'integer' },
        projectLocator: { type: 'string' },
        fix: { type: 'string', enum: ['partial', 'complete'], description: 'complete (the default) fixes every vulnerability of the package version; partial fixes this one with a smaller upgrade.' },
      },
      required: ['id', 'projectLocator'],
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    handle: async (deps, args) => {
      const fix = str(args.fix)
      const result = await deps
        .fossa()
        .requestFixPr(need(int(args.id), 'id'), need(str(args.projectLocator), 'projectLocator'), fix === 'partial' || fix === 'complete' ? fix : undefined)
      return { content: [{ type: 'text', text: `fossabot accepted the request: ${JSON.stringify(result)}` }] }
    },
  },
  {
    name: 'fossa_rerun_check',
    title: 'Rerun the FOSSA check',
    description: 'Rerun the failed jobs of the GitHub Actions run that holds the FOSSA check, after an ignore or a fix. Uses GitHub only.',
    inputSchema: {
      type: 'object',
      properties: { repo: repoArg, runId: { type: 'string', description: 'The check.runId from fossa_pr_issues.' } },
      required: ['runId'],
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    handle: async (deps, args) => {
      const repo = await resolveRepo(deps.gh, str(args.repo), deps.cwd)
      const runId = need(str(args.runId), 'runId')
      await rerunFailed(deps.gh, repo, runId)
      return { content: [{ type: 'text', text: `Rerunning the failed jobs of run ${runId} in ${repo}.` }] }
    },
  },
]

export async function callTool(deps: Deps, name: string, args: Record<string, unknown>): Promise<ToolResult> {
  const tool = TOOLS.find(one => one.name === name)
  if (!tool) return failure(`No tool named ${name}.`)
  try {
    return await tool.handle(deps, args)
  } catch (err) {
    return failure(explain(err))
  }
}

export async function prReport(deps: Deps, repoArg: string | undefined, prArg: number | undefined): Promise<PrReport> {
  const repo = await resolveRepo(deps.gh, repoArg, deps.cwd)
  const pr = await pullRequest(deps.gh, repo, prArg, deps.cwd)
  const fossa = deps.fossa()

  // CI's default project is the origin remote without its scheme, which is
  // what GitHub Actions checks out: custom+<org>/github.com/<owner>/<name>.
  const orgId = await fossa.organizationId()
  let projectLocator = `custom+${orgId}/github.com/${repo}`
  let head = await fossa.revisionIssues(`${projectLocator}$${pr.headSha}`)
  if (head.kind === 'not-found' && pr.fossaCheck?.jobId) {
    const fromLog = await projectFromJobLog(deps.gh, repo, pr.fossaCheck.jobId).catch(() => undefined)
    const logOrg = fromLog?.match(/^custom\+(\d+)\//)?.[1]
    // A key only sees its own org, so a project in another org reads as not found.
    if (logOrg && Number(logOrg) !== orgId) {
      throw new Error(
        `CI uploads ${repo} to FOSSA org ${logOrg} (project ${fromLog}), but the API key belongs to org ${orgId}. Use a full-access key from org ${logOrg}.`,
      )
    }
    if (fromLog && fromLog !== projectLocator) {
      projectLocator = fromLog
      head = await fossa.revisionIssues(`${projectLocator}$${pr.headSha}`)
    }
  }

  const report: PrReport = {
    repo,
    pr: pr.number,
    title: pr.title,
    url: pr.url,
    headSha: pr.headSha,
    projectLocator,
    check: pr.fossaCheck,
    status: head.kind === 'scanned' ? 'scanned' : head.kind === 'waiting' ? 'waiting' : 'not-analyzed',
    issues: [],
  }
  if (head.kind !== 'scanned') return report
  if (!head.hasDetails) throw new Error('FOSSA returned the issue count but no details. FOSSA_API_KEY is a push-only key; use a full-access key.')

  const baseSha = await mergeBase(deps.gh, repo, pr.baseRef, pr.headSha).catch(() => undefined)
  const base: IssuesResult | undefined = baseSha ? await fossa.revisionIssues(`${projectLocator}$${baseSha}`) : undefined
  const baseIds = base?.kind === 'scanned' ? new Set(base.issues.map(issue => issue.id)) : undefined

  report.baseSha = baseSha
  report.issues = head.issues.map(issue => toIssue(issue, baseIds))
  await checkFossabot(fossa, projectLocator, report.issues)
  if (baseIds) report.newCount = report.issues.filter(issue => issue.isNew).length
  return report
}

// The package managers fossabot opens upgrade PRs for. FOSSA refuses the
// request for any other package manager.
const FOSSABOT_FETCHERS = new Set(['npm', 'mvn', 'pip'])

// Sets each issue's fossabot field with the checks Core makes when it creates a
// PR. The free checks run first; the one FOSSA call runs only when an issue
// passes them.
async function checkFossabot(fossa: FossaClient, projectLocator: string, issues: Issue[]): Promise<void> {
  for (const issue of issues) {
    if (issue.category !== 'vulnerability' || issue.type !== 'vulnerability') {
      issue.fossabot = { canOpen: false, reason: 'fossabot fixes only dependency vulnerabilities' }
    } else if (!FOSSABOT_FETCHERS.has(issue.fetcher)) {
      issue.fossabot = { canOpen: false, reason: `fossabot does not fix ${issue.fetcher || 'these'} dependencies (only npm, mvn and pip)` }
    } else if (!issue.fixedIn) {
      issue.fossabot = { canOpen: false, reason: 'FOSSA knows no fix version for this issue' }
    }
  }
  const candidates = issues.filter(issue => issue.fossabot.canOpen)
  if (candidates.length === 0) return

  let reason: string | undefined
  try {
    const status = await fossa.fossabotStatus(projectLocator)
    if (!status.connected) reason = 'fossabot is not connected for this repository'
    else if (status.creditLevel === 'exhausted') reason = 'the organization is out of fossabot credits'
  } catch (err) {
    if (err instanceof FossaApiError && /not enabled in this organization/.test(err.message)) {
      reason = 'fossabot upgrade PRs are not enabled for this FOSSA organization'
    } else if (err instanceof FossaApiError && err.status === 403) {
      reason = 'your FOSSA user cannot create fossabot PRs'
    } else {
      reason = `could not check fossabot: ${err instanceof Error ? err.message : String(err)}`
    }
  }
  if (reason) for (const issue of candidates) issue.fossabot = { canOpen: false, reason }
}

function toIssue(raw: CliIssue, baseIds: Set<number> | undefined): Issue {
  const dep = parseLocator(raw.revisionId ?? '')
  return {
    id: raw.id,
    type: raw.type,
    category: categoryOf(raw.type),
    package: dep.name || 'unknown package',
    version: dep.version,
    fetcher: dep.fetcher,
    cve: raw.cve,
    severity: raw.priorityString,
    fixedIn: raw.fixedIn,
    license: raw.license,
    dashUrl: raw.issueDashURL,
    isNew: baseIds ? !baseIds.has(raw.id) : undefined,
    // checkFossabot narrows this.
    fossabot: { canOpen: true },
  }
}

export function describeReport(report: PrReport): string {
  const head = `${report.repo}#${report.pr} "${report.title}" at ${report.headSha.slice(0, 7)}`
  const check = report.check ? `FOSSA check "${report.check.name}": ${report.check.state}${report.check.runId ? ` (runId ${report.check.runId})` : ''}.` : 'No FOSSA check on this PR.'
  if (report.status === 'waiting') return `${head}\n${check}\nFOSSA is still scanning this commit. Try again in a minute.`
  if (report.status === 'not-analyzed') return `${head}\n${check}\nFOSSA has no analysis of this commit in project ${report.projectLocator}. CI may not have run fossa analyze yet.`
  if (report.issues.length === 0) return `${head}\n${check}\nFOSSA reports no issues on this commit.`

  const base = report.baseSha?.slice(0, 7)
  const compared =
    report.newCount === undefined
      ? 'FOSSA has no scan of the base commit, so new and old issues are not told apart.'
      : report.newCount === report.issues.length
        ? `All are new in this PR: the base branch at ${base} does not have them.`
        : report.newCount === 0
          ? `None is new: all are already on the base branch at ${base}.`
          : `${report.newCount} of ${report.issues.length} are new in this PR; the others are already on the base branch at ${base}.`
  const lines = report.issues.map(issue => {
    const what = [issue.type, issue.cve, issue.severity, issue.license].filter(Boolean).join(', ')
    const fix = issue.fixedIn ? `; fixed in ${issue.fixedIn}` : ''
    const age = issue.isNew === undefined ? '' : issue.isNew ? ' [new]' : ' [on base]'
    const bot = issue.fossabot.canOpen ? '; fossabot can open an upgrade PR' : ''
    return `- id ${issue.id} (${issue.category})${age}: ${issue.package}${issue.version ? '@' + issue.version : ''}: ${what}${fix}${bot}`
  })
  return [head, check, `${report.issues.length} ${report.issues.length === 1 ? 'issue' : 'issues'}. ${compared}`, `projectLocator: ${report.projectLocator}`, ...lines].join('\n')
}

function explain(err: unknown): string {
  if (err instanceof FossaApiError && (err.status === 401 || err.status === 403)) {
    return `${err.message}\nFOSSA refused the key. Use a full-access API key of a user who can edit the project.`
  }
  return err instanceof Error ? err.message : String(err)
}

function failure(text: string): ToolResult {
  return { content: [{ type: 'text', text }], isError: true }
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

function int(value: unknown): number | undefined {
  const n = typeof value === 'string' ? Number(value) : value
  return typeof n === 'number' && Number.isInteger(n) ? n : undefined
}

function need<T>(value: T | undefined, name: string): T {
  if (value === undefined) throw new Error(`${name} is required.`)
  return value
}

function category(value: unknown): Category {
  if (value === 'vulnerability' || value === 'licensing' || value === 'quality') return value
  throw new Error('category must be vulnerability, licensing, or quality.')
}
