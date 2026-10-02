// The fossa-pr mod: draws a PR's FOSSA issues in a pane, with buttons to
// explain, fix, ignore, or hand an issue to fossabot. It also watches the
// current branch's PR on GitHub and toasts when the FOSSA check fails.
//
// All FOSSA work goes through the plugin's own MCP server (mcp/server.ts),
// which paces and caches every call to Core. This file never calls FOSSA.

import { atom, read, update } from 'claude-code'
import type { EngineInterface, McpToolResult, Register, RenderSurface, ToolCallResult } from 'claude-code'

import { fossaCheckOf } from '../mcp/check.ts'
import type { Issue, PrReport } from '../types'

const PANE = 'fossa-pr'
const USAGE = 'Run /fossa-pr <number>, or /fossa-pr owner/repo#<number>.'
const WATCH_MS = 60_000

const report = atom({ plugin: 'fossa-pr', key: 'report' } as const, null)
const busy = atom({ plugin: 'fossa-pr', key: 'busy' } as const, null)
const note = atom({ plugin: 'fossa-pr', key: 'note' } as const, null)
const seen = atom({ plugin: 'fossa-pr', key: 'seen' } as const, null)

// Labels the ignore question offers for a vulnerability, and the reason FOSSA records for each.
const VULN_REASONS: Record<string, string> = {
  'Code not in execute path': 'Vulnerable_code_not_in_execute_path',
  'Code not present': 'Vulnerable_code_not_present',
  'Incorrect data': 'incorrect_data_found',
  'Under investigation': 'Under_investigation',
}
const OTHER_REASONS = ['Approved for this project', 'Not shipped to customers', 'Incorrect data']

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'fossa-pr',
      description: 'Show the FOSSA issues on a pull request in a pane',
      argumentHint: '[owner/repo#]<pr number>',
    })
    $.clock.every(WATCH_MS, () => watchOnce($))
    void watchOnce($)
    return next(e)
  })

  on('command.run', { command: 'fossa-pr' }, async ($, e) => {
    // `166`, `#166`, `owner/repo#166`, `owner/repo 166`, or nothing.
    const target = e.args.trim().match(/^(?:([\w.-]+\/[\w.-]+)\s*#?\s*)?#?(\d+)?$/)
    if (!target) return { text: USAGE }
    // Open the pane first, with the keyboard, so even an error shows in it.
    // When the host does not place it, the command's text says why.
    let unplaced: string | undefined
    try {
      const opened = await $.ui.open({ id: PANE, title: 'FOSSA issues', focus: true })
      if (!opened.isPlaced) unplaced = opened.reason
    } catch (err) {
      unplaced = messageOf(err)
    }
    const withPane = (text: string) => (unplaced ? `${text}\n(The pane did not open: ${unplaced})` : text)
    // The MCP server may run outside the project, so the mod finds the repo
    // and the PR here, in the session's own directory, and passes both.
    const repo = target[1] ?? (await currentRepo($)) ?? (await read($, report))?.repo
    // The checked-out branch's PR counts only when no other repo was named.
    const number = target[2] !== undefined ? Number(target[2]) : target[1] ? undefined : (await currentPr($))?.number
    if (!repo || number === undefined) {
      const problem = !repo ? `This directory is not a GitHub clone. ${USAGE}` : `No pull request to show. ${USAGE}`
      await update($, note, () => problem)
      return { text: withPane(problem) }
    }
    return { text: withPane(await load($, repo, number)) }
  })

  // Claude can call the tool itself ("show the FOSSA issues on this PR"), so
  // the pane follows the tool, not only the /fossa-pr command.
  on('tool.call', { tool: /^mcp__.*fossa__fossa_pr_issues$/ }, async ($, e, next) => {
    const ran = await next(e)
    await showToolResult($, ran)
    return ran
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button, Markdown } = $.ui.resolve(e)
    const r = await read($, report)
    const doing = await read($, busy)
    const last = await read($, note)
    const width = e.props.bodyColumns ?? e.viewport?.columns ?? 80

    if (!r) {
      return (
        <Box flexDirection="column">
          <Text dimColor>{doing ?? last ?? 'Run /fossa-pr to load the FOSSA issues of this branch’s PR.'}</Text>
        </Box>
      )
    }

    // Count from the rows on screen: an ignore removes one without a new report.
    const fresh = r.issues.filter(issue => issue.isNew).length
    // One line for why no row offers a fossabot PR, instead of one per row.
    const botReason = r.issues.length > 0 && !r.issues.some(issue => issue.fossabot?.canOpen) ? r.issues.find(issue => issue.fossabot?.reason)?.fossabot.reason : undefined
    const compared =
      r.newCount === undefined
        ? 'no base scan to compare with'
        : `${fresh} new in this PR, ${r.issues.length - fresh} already on the base branch`

    return (
      <Box flexDirection="column" gap={1} width={width}>
        <Box flexDirection="column">
          <Text bold wrap="truncate-end">
            {r.repo}#{r.pr} {r.title}
          </Text>
          <Text dimColor>
            {r.check ? `${r.check.name}: ${r.check.state}` : 'no FOSSA check'} · {r.headSha.slice(0, 7)}
          </Text>
        </Box>

        {r.status === 'waiting' && <Text>FOSSA is still scanning this commit. Refresh in a minute.</Text>}
        {r.status === 'not-analyzed' && <Text>FOSSA has no analysis of this commit in {r.projectLocator}.</Text>}
        {r.status === 'scanned' && r.issues.length === 0 && <Text color="green">No FOSSA issues on this commit.</Text>}
        {r.status === 'scanned' && r.issues.length > 0 && (
          <Text dimColor>
            {r.issues.length} {r.issues.length === 1 ? 'issue' : 'issues'}: {compared}
          </Text>
        )}

        {r.issues.map(issue => (
          <Box key={`issue-${issue.id}`} flexDirection="column">
            <Text wrap="truncate-end">
              <Text color={severityColor(issue.severity)}>{issue.severity ?? issue.category}</Text>{' '}
              <Text bold>
                {issue.package}
                {issue.version ? `@${issue.version}` : ''}
              </Text>{' '}
              <Text dimColor>
                {[issue.type.replace(/_/g, ' '), issue.cve, issue.license, issue.fixedIn && `fixed in ${issue.fixedIn}`]
                  .filter(Boolean)
                  .join(' · ')}
                {issue.isNew === undefined ? '' : issue.isNew ? ' · new in PR' : ' · on base'}
              </Text>
            </Text>
            <Box flexDirection="row" gap={1} flexWrap="wrap">
              <Button key={`fix-${issue.id}`} variant="primary" label="Fix" onPress={() => handToClaude($, fixPrompt(r, issue))} />
              <Button key={`explain-${issue.id}`} label="Explain" onPress={() => handToClaude($, explainPrompt(r, issue))} />
              <Button key={`ignore-${issue.id}`} label="Ignore" onPress={() => ignore($, r, issue)} />
              {issue.fossabot?.canOpen && (
                <Button key={`bot-${issue.id}`} label="fossabot PR" onPress={() => fossabot($, r, issue)} />
              )}
              {issue.dashUrl && (
                <Button key={`open-${issue.id}`} label="Open in FOSSA" onPress={press => openLink($, issue.dashUrl ?? '', press.surface)} />
              )}
              {issue.dashUrl && <Markdown key={`link-${issue.id}`} text={`[↗](${issue.dashUrl})`} />}
            </Box>
          </Box>
        ))}

        {botReason && <Text dimColor>fossabot PRs: {botReason}</Text>}

        <Box flexDirection="row" gap={1}>
          <Button key="refresh" label="Refresh" hotkey="r" onPress={() => load($, r.repo, r.pr)} />
          {r.check?.runId && <Button key="rerun" label="Rerun check" hotkey="c" onPress={() => rerun($, r)} />}
          <Button key="close" role="dismiss" label="Close" onPress={() => $.ui.close({ id: PANE })} />
        </Box>
        <Text dimColor>
          {e.props.isFocused
            ? 'Tab: next button · Enter: press · r: refresh · c: rerun check · Esc: back to the prompt'
            : 'ctrl+x tab: use the buttons'}
        </Text>
        {(doing ?? last) && <Text dimColor>{doing ?? last}</Text>}
      </Box>
    )
  })
}

// Loads the PR's report through the MCP server and keeps it for the pane.
// Resolves to the text the transcript shows.
async function load($: EngineInterface, repo: string, pr: number): Promise<string> {
  await update($, busy, () => 'Loading the FOSSA issues…')
  try {
    const result = await callFossa($, 'fossa_pr_issues', { repo, pr })
    const text = textOf(result)
    const r = result.isError ? undefined : reportOf(result)
    if (!r) {
      await update($, note, () => text || 'The FOSSA server returned no report.')
      return text
    }
    await update($, report, () => r)
    await update($, note, () => null)
    return summaryOf(r)
  } catch (err) {
    const text = `Could not load the FOSSA issues: ${messageOf(err)}`
    await update($, note, () => text)
    return text
  } finally {
    await update($, busy, () => null)
  }
}

// Puts what Claude's own fossa_pr_issues call returned in the pane, and opens it.
async function showToolResult($: EngineInterface, ran: ToolCallResult): Promise<void> {
  if (ran.deny !== undefined) return
  // The record is the tool's CallToolResult, or the report itself. Without a
  // report, the pane shows the text the model read.
  const raw = ran.result as Partial<McpToolResult> | PrReport | undefined
  const r = !raw ? undefined : 'repo' in raw ? (raw as PrReport) : reportOf(raw as Partial<McpToolResult>)
  if (ran.isError || !r) {
    await update($, note, () => ran.text ?? 'fossa_pr_issues failed.')
  } else {
    await update($, report, () => r)
    await update($, note, () => null)
  }
  let opened
  try {
    opened = await $.ui.open({ id: PANE, title: 'FOSSA issues' })
  } catch {
    return
  }
  if (!opened.isPlaced) $.ui.toast('The FOSSA issues are ready: run /fossa-pr, or widen the terminal, to see the pane.')
}

async function ignore($: EngineInterface, r: PrReport, issue: Issue): Promise<void> {
  const isVuln = issue.category === 'vulnerability'
  let answer: string
  try {
    answer = await $.ui.ask(`Why ignore ${issue.package} (${issue.cve ?? issue.type}) in ${r.repo}?`, {
      header: 'Ignore',
      options: isVuln ? Object.keys(VULN_REASONS) : OTHER_REASONS,
    })
  } catch {
    return
  }
  const reason = isVuln ? (VULN_REASONS[answer] ?? 'other') : answer === 'Incorrect data' ? 'incorrect_data_found' : undefined
  await act($, `Ignoring issue ${issue.id}…`, async () => {
    const result = await callFossa($, 'fossa_ignore_issue', {
      id: issue.id,
      category: issue.category,
      projectLocator: r.projectLocator,
      ...(reason && { reason }),
      notes: `${answer} (ignored from ${r.repo}#${r.pr} with the fossa-pr plugin)`,
    })
    if (result.isError) throw new Error(textOf(result))
    await update($, report, current =>
      current ? { ...current, issues: current.issues.filter(one => one.id !== issue.id) } : current,
    )
    return `Ignored issue ${issue.id}.${r.check?.runId ? ' Press Rerun check when you are done.' : ''}`
  })
}

async function fossabot($: EngineInterface, r: PrReport, issue: Issue): Promise<void> {
  let answer: string
  try {
    answer = await $.ui.ask(`Ask fossabot to open an upgrade PR for ${issue.package}?`, ['Ask fossabot', 'Cancel'])
  } catch {
    return
  }
  if (answer !== 'Ask fossabot') return
  await act($, `Asking fossabot about ${issue.package}…`, async () => {
    const result = await callFossa($, 'fossa_request_fix_pr', { id: issue.id, projectLocator: r.projectLocator })
    if (result.isError) throw new Error(textOf(result))
    return `fossabot will open an upgrade PR for ${issue.package}.`
  })
}

async function rerun($: EngineInterface, r: PrReport): Promise<void> {
  await act($, 'Starting the FOSSA check again…', async () => {
    const result = await callFossa($, 'fossa_rerun_check', { repo: r.repo, runId: r.check?.runId })
    if (result.isError) throw new Error(textOf(result))
    return 'The FOSSA check is running again. Refresh in a few minutes.'
  })
}

// Runs one pane action: shows `label` while it runs, then its result or error.
async function act($: EngineInterface, label: string, work: () => Promise<string>): Promise<void> {
  await update($, busy, () => label)
  try {
    const done = await work()
    await update($, note, () => done)
  } catch (err) {
    await update($, note, () => messageOf(err))
  } finally {
    await update($, busy, () => null)
  }
}

// Opens a link in the browser. Mods have no call for that, so this runs the
// platform's opener; when none works, it copies the link instead.
async function openLink($: EngineInterface, url: string, surface: RenderSurface): Promise<void> {
  for (const opener of ['open', 'xdg-open']) {
    try {
      const ran = await $.process.run([opener, url])
      if (ran.exitCode === 0) return
    } catch {
      // This opener is not on this machine: try the next one.
    }
  }
  const copied = await $.ui.copy({ text: url, surface })
  $.ui.toast(copied.isCopied ? 'Could not open the browser. The link is on your clipboard.' : `Open this link: ${url}`)
}

// Hands an issue to Claude as the user's own request.
function handToClaude($: EngineInterface, text: string): void {
  void $.prompt.submit({ text, asUser: true })
}

async function callFossa($: EngineInterface, tool: string, args: Record<string, unknown>): Promise<McpToolResult> {
  const connected = await $.mcp.connect('fossa')
  if (!connected.isConnected) throw new Error(`The fossa MCP server is not connected: ${connected.message}`)
  return $.mcp.call(connected.server, tool, args)
}

type CurrentPr = { number: number; url: string; headRefOid: string; statusCheckRollup?: [] }

// The PR of the branch checked out in the session's directory, from GitHub.
async function currentPr($: EngineInterface): Promise<CurrentPr | undefined> {
  try {
    const out = await $.process.run(['gh', 'pr', 'view', '--json', 'number,url,headRefOid,statusCheckRollup'])
    return out.exitCode === 0 ? (JSON.parse(out.stdout) as CurrentPr) : undefined
  } catch {
    return undefined
  }
}

async function currentRepo($: EngineInterface): Promise<string | undefined> {
  try {
    const out = await $.process.run(['gh', 'repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner'])
    return out.exitCode === 0 && out.stdout.trim() ? out.stdout.trim() : undefined
  } catch {
    return undefined
  }
}

// True while a watch runs, so the first call and a timer tick never overlap.
let isWatching = false

// Runs one watch unless one is running, and logs a failure instead of
// leaving it unhandled; the next tick tries again.
async function watchOnce($: EngineInterface): Promise<void> {
  if (isWatching) return
  isWatching = true
  try {
    await watch($)
  } catch (err) {
    $.ui.log(`FOSSA check watch failed: ${messageOf(err)}`, { to: 'debug' })
  } finally {
    isWatching = false
  }
}

// Polls GitHub (never FOSSA) for the current branch's PR, and toasts once per
// commit when its FOSSA check fails.
async function watch($: EngineInterface): Promise<void> {
  const pr = await currentPr($)
  const check = pr && fossaCheckOf(pr.statusCheckRollup ?? [])
  if (!pr || !check) {
    $.ui.status(undefined)
    return
  }
  const key = `${pr.headRefOid}:${check.state}`
  const previous = await read($, seen)
  if (check.state === 'FAILURE' || check.state === 'ERROR') {
    $.ui.status(`${check.name} failed on #${pr.number} · /fossa-pr`)
    if (previous !== key) $.ui.toast(`${check.name} failed on #${pr.number}. Run /fossa-pr to see the issues.`)
  } else {
    $.ui.status(undefined)
  }
  if (previous !== key) await update($, seen, () => key)
}

function fixPrompt(r: PrReport, issue: Issue): string {
  const target = issue.fixedIn ? `to ${issue.fixedIn}` : 'to a version without the issue'
  return (
    `Fix FOSSA issue ${issue.id} on ${r.repo}#${r.pr}: ${issue.package}${issue.version ? '@' + issue.version : ''} ` +
    `(${[issue.type, issue.cve].filter(Boolean).join(', ')}). Upgrade it ${target}, run the tests, and show me the change before you commit or push.`
  )
}

function explainPrompt(r: PrReport, issue: Issue): string {
  return (
    `Explain FOSSA issue ${issue.id} (${issue.category}) on ${r.repo}#${r.pr}: ${issue.package}${issue.version ? '@' + issue.version : ''}. ` +
    `Use fossa_issue with projectLocator ${r.projectLocator} and revision ${r.headSha} for the details, then say whether this code uses the affected part, and whether to fix or ignore it.`
  )
}

function severityColor(severity: string | undefined): string | undefined {
  if (severity === 'critical' || severity === 'high') return 'red'
  if (severity === 'medium') return 'yellow'
  return undefined
}

// The report from structuredContent, or from a content block. $.mcp.call can
// drop structuredContent, and for a tool with an output schema Claude Code may
// replace the content with one text block of the structured JSON. The server
// also sends the report as a JSON resource block.
function reportOf(result: Partial<McpToolResult>): PrReport | undefined {
  const structured = result.structuredContent as PrReport | undefined
  if (structured?.repo) return structured
  for (const block of result.content ?? []) {
    const resource = block.type === 'resource' ? ((block.resource ?? block) as { uri?: string; text?: string }) : undefined
    const json = resource?.uri === 'fossa-pr://report' ? resource.text : block.type === 'text' ? block.text : undefined
    if (!json?.trimStart().startsWith('{')) continue
    try {
      const parsed = JSON.parse(json) as PrReport
      if (parsed?.repo && Array.isArray(parsed.issues)) return parsed
    } catch {
      // Not the report: try the next block.
    }
  }
  return undefined
}

// One line for the transcript: the pane shows the rest.
function summaryOf(r: PrReport): string {
  const head = `${r.repo}#${r.pr}`
  if (r.status === 'waiting') return `${head}: FOSSA is still scanning this commit.`
  if (r.status === 'not-analyzed') return `${head}: FOSSA has no analysis of this commit.`
  const n = r.issues.length
  if (n === 0) return `${head}: no FOSSA issues.`
  const fresh = r.issues.filter(issue => issue.isNew).length
  const compared = r.newCount === undefined ? '' : `, ${fresh} new in this PR`
  return `${head}: ${n} FOSSA ${n === 1 ? 'issue' : 'issues'}${compared}.`
}

function textOf(result: McpToolResult): string {
  return result.content.map(block => (block.type === 'text' ? block.text : '')).filter(Boolean).join('\n').trim()
}

function messageOf(err: unknown): string {
  // Claude Code's own errors already start with the plugin's name.
  const text = (err instanceof Error ? err.message : String(err)).replace(/^fossa-pr: /, '')
  // A permission refusal carries a long note meant for the model; show one line.
  // Live sessions say "$.mcp.call(server, tool) refused: ..."; the test kit "$.mcp.call: ...".
  const refused = text.match(/^\$\.mcp\.call(?:\([^,]+, (\w+)\) refused)?: /)
  if (!refused) return text
  const tool = refused[1] ?? 'fossa_pr_issues'
  return `The permission check refused ${tool}. To allow it, add mcp__plugin_fossa-pr_fossa__${tool} to permissions.allow in your settings.`
}
