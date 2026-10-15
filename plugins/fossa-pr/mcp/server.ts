// fossa-pr MCP server: newline-delimited JSON-RPC over stdio, no dependencies.
// Run with Node 22.18 or later, which runs .ts files as they are.

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'

import { FossaClient } from './fossa.ts'
import { runGh } from './github.ts'
import { TOOLS, WIDGET_URI, callTool } from './tools.ts'
import type { Deps } from './tools.ts'

const SERVER_INFO = { name: 'fossa-pr', version: '0.1.0' }
const PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05']
const WIDGET_MIME = 'text/html;profile=mcp-app'
const KEY_FILE = join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'fossa-pr', 'api-key')

const widgetHtml = readFileSync(new URL('./widget.html', import.meta.url), 'utf8')

let client: FossaClient | undefined

export const deps: Deps = {
  gh: runGh,
  cwd: process.cwd(),
  fossa: () => {
    client ??= new FossaClient({ apiKey: apiKey(), endpoint: process.env.FOSSA_ENDPOINT })
    return client
  },
}

function apiKey(): string {
  const fromEnv = process.env.FOSSA_API_KEY?.trim()
  if (fromEnv) return fromEnv
  try {
    const fromFile = readFileSync(KEY_FILE, 'utf8').trim()
    if (fromFile) return fromFile
  } catch {
    // No key file: the error below says how to add one.
  }
  throw new Error(`No FOSSA API key. Set FOSSA_API_KEY, or put a full-access key in ${KEY_FILE} (chmod 600).`)
}

type Request = { jsonrpc: '2.0'; id?: number | string; method: string; params?: Record<string, any> }

export async function handle(request: Request): Promise<unknown> {
  const params = request.params ?? {}
  switch (request.method) {
    case 'initialize': {
      const asked = String(params.protocolVersion ?? '')
      return {
        protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
        capabilities: { tools: {}, resources: {} },
        serverInfo: SERVER_INFO,
        instructions:
          'FOSSA issues on GitHub pull requests. Call fossa_pr_issues first; it returns the issue ids, categories and the projectLocator the other tools take. Ask the user before fossa_ignore_issue or fossa_request_fix_pr.',
      }
    }
    case 'ping':
      return {}
    case 'tools/list':
      return { tools: TOOLS.map(({ handle: _handle, ...tool }) => tool) }
    case 'tools/call':
      return callTool(deps, String(params.name), params.arguments ?? {})
    case 'resources/list':
      return { resources: [{ uri: WIDGET_URI, name: 'fossa_pr_issues_view', title: 'FOSSA issues on a PR', mimeType: WIDGET_MIME }] }
    case 'resources/read':
      if (params.uri !== WIDGET_URI) throw rpcError(-32002, `No resource ${params.uri}`)
      return { contents: [{ uri: WIDGET_URI, mimeType: WIDGET_MIME, text: widgetHtml, _meta: { ui: { prefersBorder: true } } }] }
    default:
      throw rpcError(-32601, `Method not found: ${request.method}`)
  }
}

function rpcError(code: number, message: string): Error & { code: number } {
  return Object.assign(new Error(message), { code })
}

function send(message: unknown): void {
  process.stdout.write(JSON.stringify(message) + '\n')
}

function serve(): void {
  // The host closed the pipe (it stopped the server mid-call): nobody is left to answer.
  process.stdout.on('error', () => process.exit(0))
  const lines = createInterface({ input: process.stdin })
  lines.on('line', async line => {
    if (!line.trim()) return
    let request: Request
    try {
      request = JSON.parse(line)
    } catch {
      send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } })
      return
    }
    // A notification (no id) gets no answer.
    if (request.id === undefined) return
    try {
      send({ jsonrpc: '2.0', id: request.id, result: await handle(request) })
    } catch (err) {
      const code = typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : -32603
      send({ jsonrpc: '2.0', id: request.id, error: { code, message: err instanceof Error ? err.message : String(err) } })
    }
  })
  lines.on('close', () => process.exit(0))
}

if (import.meta.main) serve()
