// Codex SessionStart hook. When the current branch's PR has a failing FOSSA
// check, prints one line that Codex adds to the model's context, with the repo
// and PR number the fossa_ tools take (the MCP server runs in the plugin's own
// folder, so it cannot find them itself). Prints nothing otherwise. Calls
// GitHub only, never FOSSA, and always exits 0 so a session never waits on it.

import { execFile } from 'node:child_process'

import { fossaCheckOf } from './check.ts'

// Codex pipes the hook input and closes stdin. Run by hand from a terminal, or
// with stdin left open, the hook gives up on it after 2 seconds.
const stdin = process.stdin.isTTY
  ? ''
  : await new Promise<string>(resolve => {
      let text = ''
      // Close stdin when done: an open stdin keeps the process alive.
      const done = () => {
        process.stdin.destroy()
        resolve(text)
      }
      setTimeout(done, 2000).unref()
      process.stdin.setEncoding('utf8')
      process.stdin.on('data', chunk => (text += chunk))
      process.stdin.on('end', done)
      process.stdin.on('error', done)
    })

let cwd = process.cwd()
try {
  cwd = JSON.parse(stdin).cwd || cwd
} catch {
  // No hook input: use the process's own directory.
}

execFile('gh', ['pr', 'view', '--json', 'number,url,statusCheckRollup'], { cwd, timeout: 10_000 }, (err, stdout) => {
  if (err) return
  let pr: { number: number; url: string; statusCheckRollup?: [] }
  try {
    pr = JSON.parse(stdout)
  } catch {
    return
  }
  const check = fossaCheckOf(pr.statusCheckRollup ?? [])
  const repo = pr.url.match(/github\.com\/([^/]+\/[^/]+)\/pull\//)?.[1]
  if (!check || !repo || (check.state !== 'FAILURE' && check.state !== 'ERROR')) return
  process.stdout.write(
    `The FOSSA check "${check.name}" failed on ${repo}#${pr.number}, the PR of the current branch. ` +
      `If the user asks about it, or before you push, use the fossa-triage skill: call fossa_pr_issues with repo "${repo}" and pr ${pr.number}.\n`,
  )
})
