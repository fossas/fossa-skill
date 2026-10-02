import { expect, test } from 'claude-code/testing'

const REPORT = {
  repo: 'acme/api',
  pr: 166,
  title: 'Warn releases',
  url: 'https://github.com/acme/api/pull/166',
  headSha: '1111111111111111111111111111111111111111',
  baseSha: '2222222222222222222222222222222222222222',
  projectLocator: 'custom+42/github.com/acme/api',
  check: { name: 'check-fossa', state: 'FAILURE', runId: '1001', jobId: '2002' },
  status: 'scanned',
  issues: [
    {
      id: 7,
      type: 'vulnerability',
      category: 'vulnerability',
      package: 'golang.org/x/net',
      version: 'v0.23.0',
      fetcher: 'go',
      cve: 'CVE-2024-45338',
      severity: 'high',
      fixedIn: 'v0.33.0',
      dashUrl: 'https://app.fossa.com/projects/x/issues/7',
      isNew: false,
    },
  ],
  newCount: 0,
}

const PANE = {
  component: 'Pane',
  requestId: 'fossa-pr',
  props: { title: 'FOSSA issues', isFocused: true, bodyColumns: 100, placement: 'dock' },
} as const

// Stands in for the plugin's MCP server and for GitHub; records each MCP call.
function fakes(on: any, calls: Array<{ tool: string; args: Record<string, unknown> }>) {
  on('mcp.connect', () => ({ value: { isConnected: true, server: 'plugin:fossa-pr:fossa' } }))
  on('mcp.call', (_$: unknown, e: { tool: string; args: Record<string, unknown> }) => {
    calls.push({ tool: e.tool, args: e.args })
    if (e.tool === 'fossa_pr_issues') {
      return { value: { content: [{ type: 'text', text: '1 issues on acme/api#166' }], isError: false, structuredContent: REPORT } }
    }
    return { value: { content: [{ type: 'text', text: 'ok' }], isError: false } }
  })
  on('ui.open', () => ({ value: { isPlaced: true } }))
  // The session is in a clone of acme/api on a branch with no PR, so the watch stays quiet.
  on('process.run', (_$: unknown, e: { argv: string[] }) =>
    e.argv[1] === 'repo'
      ? { value: { exitCode: 0, stdout: 'acme/api\n', stderr: '' } }
      : { value: { exitCode: 1, stdout: '', stderr: 'no pull requests found' } },
  )
}

test('/fossa-pr loads the report through the MCP server and draws it', async ($, on) => {
  const calls: Array<{ tool: string; args: Record<string, unknown> }> = []
  fakes(on, calls)

  const answer = await $.command.run({ command: 'fossa-pr', args: '166' })
  expect(answer.text).toBe('acme/api#166: 1 FOSSA issue, 0 new in this PR.')
  expect(calls).toEqual([{ tool: 'fossa_pr_issues', args: { repo: 'acme/api', pr: 166 } }])

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'fossa-pr', surface, ...(PANE as any) })
    expect(await ui.find({ type: 'Text', text: /golang\.org\/x\/net@v0\.23\.0/ })).toBeDefined()
    expect(await ui.find({ key: 'fix-7' })).toBeDefined()
    expect(await ui.find({ key: 'rerun' })).toBeDefined()
    await ui.unmount()
  }
})

test("Claude's own fossa_pr_issues call fills and opens the pane", async ($, on) => {
  const calls: Array<{ tool: string; args: Record<string, unknown> }> = []
  const opened: string[] = []
  // Before fakes(), so that this hook answers the pane's ui.open first.
  on('ui.open', { id: 'fossa-pr' }, (_$: unknown, e: { id: string }) => {
    opened.push(e.id)
    return { value: { isPlaced: true } }
  })
  fakes(on, calls)
  const TOOL = 'mcp__plugin_fossa-pr_fossa__fossa_pr_issues'
  on('tool.call', { tool: TOOL }, () => ({
    result: { content: [{ type: 'text', text: '1 issue' }], structuredContent: REPORT },
  }))

  await $.tool.call({ tool: TOOL, repo: 'acme/api', pr: 166 } as any)
  expect(opened).toEqual(['fossa-pr'])
  const ui = await $.ui.mount({ plugin: 'fossa-pr', surface: 'terminal', ...(PANE as any) })
  expect(await ui.find({ key: 'fix-7' })).toBeDefined()
  await ui.unmount()
})

test("an error from Claude's call shows in the pane", async ($, on) => {
  const calls: Array<{ tool: string; args: Record<string, unknown> }> = []
  fakes(on, calls)
  const TOOL = 'mcp__plugin_fossa-pr_fossa__fossa_pr_issues'
  on('tool.call', { tool: TOOL }, () => ({ result: { content: [{ type: 'text', text: 'wrong org' }] }, isError: true, text: 'wrong org' }) as any)

  await $.tool.call({ tool: TOOL, repo: 'acme/api', pr: 166 } as any)
  const ui = await $.ui.mount({ plugin: 'fossa-pr', surface: 'terminal', ...(PANE as any) })
  expect(await ui.find({ type: 'Text', text: /wrong org/ })).toBeDefined()
  await ui.unmount()
})

test('owner/repo#number works outside a clone, and the error case shows in the pane', async ($, on) => {
  const calls: Array<{ tool: string; args: Record<string, unknown> }> = []
  // Not a clone: gh repo view fails. Registered before fakes(), so it answers first.
  on('process.run', { argv: ['gh', 'repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner'] }, () => ({
    value: { exitCode: 1, stdout: '', stderr: 'not a git repository' },
  }))
  fakes(on, calls)

  const missing = await $.command.run({ command: 'fossa-pr', args: '166' })
  expect(missing.text).toBe('This directory is not a GitHub clone. Run /fossa-pr <number>, or /fossa-pr owner/repo#<number>.')
  const ui = await $.ui.mount({ plugin: 'fossa-pr', surface: 'terminal', ...(PANE as any) })
  expect(await ui.find({ type: 'Text', text: /not a GitHub clone/ })).toBeDefined()
  await ui.unmount()

  await $.command.run({ command: 'fossa-pr', args: 'acme/api#166' })
  expect(calls).toEqual([{ tool: 'fossa_pr_issues', args: { repo: 'acme/api', pr: 166 } }])
})

test('a result without structuredContent is read from the JSON resource block', async ($, on) => {
  const calls: Array<{ tool: string; args: Record<string, unknown> }> = []
  on('mcp.call', { tool: 'fossa_pr_issues' }, () => ({
    value: {
      content: [
        { type: 'text', text: 'summary' },
        { type: 'resource', resource: { uri: 'fossa-pr://report', mimeType: 'application/json', text: JSON.stringify(REPORT) } },
      ],
      isError: false,
    },
  }))
  fakes(on, calls)
  const answer = await $.command.run({ command: 'fossa-pr', args: 'acme/api#166' })
  expect(answer.text).toBe('acme/api#166: 1 FOSSA issue, 0 new in this PR.')
  const ui = await $.ui.mount({ plugin: 'fossa-pr', surface: 'terminal', ...(PANE as any) })
  expect(await ui.find({ key: 'fix-7' })).toBeDefined()
  await ui.unmount()
})

test('a result whose only content is the report as JSON text draws rows, not JSON', async ($, on) => {
  const calls: Array<{ tool: string; args: Record<string, unknown> }> = []
  // What a live session returned: one text block holding the structured JSON.
  on('mcp.call', { tool: 'fossa_pr_issues' }, () => ({
    value: { content: [{ type: 'text', text: JSON.stringify(REPORT) }], isError: false },
  }))
  fakes(on, calls)
  const answer = await $.command.run({ command: 'fossa-pr', args: 'acme/api#166' })
  expect(answer.text).toBe('acme/api#166: 1 FOSSA issue, 0 new in this PR.')
  const ui = await $.ui.mount({ plugin: 'fossa-pr', surface: 'terminal', ...(PANE as any) })
  expect(await ui.find({ key: 'fix-7' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /"repo"/ })).toBeUndefined()
  await ui.unmount()
})

test('a permission refusal shows one short line', async ($, on) => {
  const calls: Array<{ tool: string; args: Record<string, unknown> }> = []
  // { deny } rejects the caller, as Claude Code's permission check does.
  on('mcp.call', { tool: 'fossa_pr_issues' }, () => ({
    deny: 'The server-side auto mode classifier gave no verdict. Issue the action again once.',
  }))
  fakes(on, calls)
  const answer = await $.command.run({ command: 'fossa-pr', args: 'acme/api#166' })
  expect(answer.text).toBe(
    'Could not load the FOSSA issues: The permission check refused fossa_pr_issues. To allow it, add mcp__plugin_fossa-pr_fossa__fossa_pr_issues to permissions.allow in your settings.',
  )
})

test('Open in FOSSA is a button that opens the issue in the browser', async ($, on) => {
  const calls: Array<{ tool: string; args: Record<string, unknown> }> = []
  const opened: string[][] = []
  // Before fakes(), so that this hook answers the open command first.
  on('process.run', { argv: ['open', 'https://app.fossa.com/projects/x/issues/7'] }, (_$: unknown, e: { argv: string[] }) => {
    opened.push([...e.argv])
    return { value: { exitCode: 0, stdout: '', stderr: '' } }
  })
  fakes(on, calls)
  await $.command.run({ command: 'fossa-pr', args: 'acme/api#166' })
  const ui = await $.ui.mount({ plugin: 'fossa-pr', surface: 'terminal', ...(PANE as any) })
  await ui.press({ key: 'open-7' })
  expect(opened).toEqual([['open', 'https://app.fossa.com/projects/x/issues/7']])
  await ui.unmount()
})

test('fossabot PR shows only where fossabot can open one, else one reason line', async ($, on) => {
  const blocked = { ...REPORT, issues: [{ ...REPORT.issues[0], fossabot: { canOpen: false, reason: 'fossabot does not fix go dependencies' } }] }
  const open = { ...REPORT, issues: [{ ...REPORT.issues[0], fossabot: { canOpen: true } }] }
  let next: unknown = blocked
  on('mcp.call', { tool: 'fossa_pr_issues' }, () => ({ value: { content: [{ type: 'text', text: JSON.stringify(next) }], isError: false } }))
  fakes(on, [])

  await $.command.run({ command: 'fossa-pr', args: 'acme/api#166' })
  let ui = await $.ui.mount({ plugin: 'fossa-pr', surface: 'terminal', ...(PANE as any) })
  expect(await ui.find({ key: 'bot-7' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /fossabot PRs: fossabot does not fix go dependencies/ })).toBeDefined()
  await ui.unmount()

  next = open
  await $.command.run({ command: 'fossa-pr', args: 'acme/api#166' })
  ui = await $.ui.mount({ plugin: 'fossa-pr', surface: 'terminal', ...(PANE as any) })
  expect(await ui.find({ key: 'bot-7' })).toBeDefined()
  await ui.unmount()
})

test('a bad argument gets the usage line and calls nothing', async ($, on) => {
  const calls: Array<{ tool: string; args: Record<string, unknown> }> = []
  fakes(on, calls)
  const answer = await $.command.run({ command: 'fossa-pr', args: 'abc' })
  expect(answer.text).toBe('Run /fossa-pr <number>, or /fossa-pr owner/repo#<number>.')
  expect(calls).toEqual([])
})

test('no number on a branch with no PR says how to name one', async ($, on) => {
  const calls: Array<{ tool: string; args: Record<string, unknown> }> = []
  fakes(on, calls)
  const answer = await $.command.run({ command: 'fossa-pr', args: '' })
  expect(answer.text).toBe('No pull request to show. Run /fossa-pr <number>, or /fossa-pr owner/repo#<number>.')
  expect(calls).toEqual([])
})

test('Ignore asks why, then ignores through the MCP server and drops the row', async ($, on) => {
  const calls: Array<{ tool: string; args: Record<string, unknown> }> = []
  fakes(on, calls)
  on('tool.call', { tool: 'AskUserQuestion' }, (_$: unknown, e: any) => ({
    result: { questions: e.questions, answers: { [e.questions[0].question]: 'Code not in execute path' } },
  }))

  await $.command.run({ command: 'fossa-pr', args: '166' })
  const ui = await $.ui.mount({ plugin: 'fossa-pr', surface: 'terminal', ...(PANE as any) })
  await ui.press({ key: 'ignore-7' })

  expect(calls[1]).toEqual({
    tool: 'fossa_ignore_issue',
    args: {
      id: 7,
      category: 'vulnerability',
      projectLocator: 'custom+42/github.com/acme/api',
      reason: 'Vulnerable_code_not_in_execute_path',
      notes: 'Code not in execute path (ignored from acme/api#166 with the fossa-pr plugin)',
    },
  })
  expect(await ui.find({ key: 'fix-7' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /Ignored issue 7/ })).toBeDefined()
  await ui.unmount()
})

test('a dismissed ignore question changes nothing', async ($, on) => {
  const calls: Array<{ tool: string; args: Record<string, unknown> }> = []
  fakes(on, calls)
  on('tool.call', { tool: 'AskUserQuestion' }, () => ({ deny: 'dismissed' }))

  await $.command.run({ command: 'fossa-pr', args: '166' })
  const ui = await $.ui.mount({ plugin: 'fossa-pr', surface: 'terminal', ...(PANE as any) })
  await ui.press({ key: 'ignore-7' })
  expect(calls.map(call => call.tool)).toEqual(['fossa_pr_issues'])
  expect(await ui.find({ key: 'fix-7' })).toBeDefined()
  await ui.unmount()
})
