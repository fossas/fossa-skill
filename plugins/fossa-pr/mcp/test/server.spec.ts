// Talks to the real server process over stdio, as Claude Code and Codex do.

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { test } from 'node:test'

function start() {
  const child = spawn(process.execPath, [new URL('../server.ts', import.meta.url).pathname], {
    env: { ...process.env, FOSSA_API_KEY: '', XDG_CONFIG_HOME: '/nonexistent' },
    stdio: ['pipe', 'pipe', 'inherit'],
  })
  const answers = new Map<number, (msg: any) => void>()
  createInterface({ input: child.stdout! }).on('line', line => {
    const msg = JSON.parse(line)
    answers.get(msg.id)?.(msg)
  })
  let id = 0
  const ask = (method: string, params?: unknown) =>
    new Promise<any>(resolve => {
      const n = ++id
      answers.set(n, resolve)
      child.stdin!.write(JSON.stringify({ jsonrpc: '2.0', id: n, method, params }) + '\n')
    })
  return { ask, notify: (method: string) => child.stdin!.write(JSON.stringify({ jsonrpc: '2.0', method }) + '\n'), stop: () => child.kill() }
}

test('speaks MCP over stdio', async () => {
  const server = start()
  try {
    const init = await server.ask('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } })
    assert.equal(init.result.protocolVersion, '2025-06-18')
    assert.deepEqual(init.result.capabilities, { tools: {}, resources: {} })
    server.notify('notifications/initialized')

    const tools = await server.ask('tools/list')
    const names = tools.result.tools.map((tool: { name: string }) => tool.name)
    assert.deepEqual(names, ['fossa_pr_issues', 'fossa_issue', 'fossa_ignore_issue', 'fossa_request_fix_pr', 'fossa_rerun_check'])
    const prTool = tools.result.tools[0]
    assert.equal(prTool._meta.ui.resourceUri, 'ui://fossa-pr/issues.html')
    assert.equal(prTool.handle, undefined)

    const widget = await server.ask('resources/read', { uri: 'ui://fossa-pr/issues.html' })
    assert.equal(widget.result.contents[0].mimeType, 'text/html;profile=mcp-app')
    assert.match(widget.result.contents[0].text, /ui\/initialize/)

    // With no key, a FOSSA tool fails as a tool result, not as a protocol error.
    const call = await server.ask('tools/call', { name: 'fossa_issue', arguments: { id: 1, category: 'vulnerability', projectLocator: 'x', revision: 'abc' } })
    assert.equal(call.result.isError, true)
    assert.match(call.result.content[0].text, /No FOSSA API key/)

    const unknown = await server.ask('nope')
    assert.equal(unknown.error.code, -32601)
  } finally {
    server.stop()
  }
})
