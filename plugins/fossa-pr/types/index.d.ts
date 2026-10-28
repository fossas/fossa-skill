// The shapes the MCP server returns and the mod keeps in $.state. The server
// (mcp/tools.ts) and the mod (hooks/register.tsx) both import them from here.

export type Category = 'vulnerability' | 'licensing' | 'quality'

export type FossaCheck = {
  name: string
  // SUCCESS, FAILURE, PENDING, and the other states GitHub reports.
  state: string
  url?: string
  runId?: string
  jobId?: string
}

export type Issue = {
  id: number
  type: string
  category: Category
  package: string
  version?: string
  fetcher: string
  cve?: string
  severity?: string
  fixedIn?: string
  license?: string
  dashUrl?: string
  // True when the base commit does not have this issue: the PR brought it in.
  // Undefined when FOSSA has no scan of the base commit to compare with.
  isNew?: boolean
  // Whether fossabot can open an upgrade PR for this issue, and why not.
  fossabot: { canOpen: boolean; reason?: string }
}

export type PrReport = {
  repo: string
  pr: number
  title: string
  url: string
  headSha: string
  baseSha?: string
  projectLocator: string
  check?: FossaCheck
  // scanned: issues hold the head commit's issues. waiting: FOSSA is still
  // scanning. not-analyzed: CI never uploaded this commit.
  status: 'scanned' | 'waiting' | 'not-analyzed'
  issues: Issue[]
  newCount?: number
}

declare module 'claude-code' {
  interface PluginState {
    'fossa-pr': {
      // The report the pane draws.
      report: PrReport | null
      // What the pane is doing now, such as "Ignoring issue 7…".
      busy: string | null
      // The last result or error line under the list.
      note: string | null
      // `<head sha>:<check state>` of the last FOSSA check the watch saw, so a
      // failure is toasted once.
      seen: string | null
    }
  }
}
