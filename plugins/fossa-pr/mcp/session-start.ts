// Codex SessionStart hook. When the current branch's PR has a failing FOSSA
// check, prints one line that Codex adds to the model's context, with the repo
// and PR number the fossa_ tools take (the MCP server runs in the plugin's own
// folder, so it cannot find them itself). Prints nothing otherwise. Calls
// GitHub only, never FOSSA, and always exits 0 so a session never waits on it.

import { execFile } from 'node:child_process'

import { fossaCheckOf } from './check.ts'

const stdin = await new Promise<string>(resolve => {
  let text = ''
  process.stdin.setEncoding('utf8')
  process.stdin.on('data', chunk => (text += chunk))
  process.stdin.on('end', () => resolve(text))
  process.stdin.on('error', () => resolve(''))
})

let cwd = process.cwd()
try {
  cwd = JSON.parse(stdin).cwd || cwd
} catch {
  // No hook input: use the process's own directory.
}

execFile('gh', ['pr', 'view', '--json', 'number,url,statusCheckRollup'], { cwd, timeout: 10_000 }, (err, stdout) => {
  if (err) return
  const pr = JSON.parse(stdout) as { number: number; url: string; statusCheckRollup?: [] }
  const check = fossaCheckOf(pr.statusCheckRollup ?? [])
  const repo = pr.url.match(/github\.com\/([^/]+\/[^/]+)\/pull\//)?.[1]
  if (!check || !repo || (check.state !== 'FAILURE' && check.state !== 'ERROR')) return
  process.stdout.write(
    `The FOSSA check "${check.name}" failed on ${repo}#${pr.number}, the PR of the current branch. ` +
      `If the user asks about it, or before you push, use the fossa-triage skill: call fossa_pr_issues with repo "${repo}" and pr ${pr.number}.\n`,
  )
})
