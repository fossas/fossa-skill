import assert from 'node:assert/strict'
import { test } from 'node:test'

import { FossaClient } from '../fossa.ts'
import { fossaCheckOf } from '../check.ts'
import type { Run } from '../github.ts'
import { callTool, prReport } from '../tools.ts'
import type { ToolResult } from '../tools.ts'

// The text block every tool result starts with.
const firstText = (result: ToolResult) => (result.content[0] as { text: string }).text

const HEAD = 'a'.repeat(40)
const BASE = 'b'.repeat(40)

// gh answers for one PR whose FOSSA check failed.
function fakeGh(log = ''): Run {
  return async args => {
    const joined = args.join(' ')
    if (joined.startsWith('pr view')) {
      return JSON.stringify({
        number: 166,
        title: 'Warn releases',
        url: 'https://github.com/acme/api/pull/166',
        headRefName: 'branch',
        headRefOid: HEAD,
        baseRefName: 'master',
        statusCheckRollup: [
          { __typename: 'CheckRun', name: 'build', status: 'COMPLETED', conclusion: 'SUCCESS', detailsUrl: 'https://x' },
          {
            __typename: 'CheckRun',
            name: 'check-fossa',
            status: 'COMPLETED',
            conclusion: 'FAILURE',
            detailsUrl: 'https://github.com/acme/api/actions/runs/1001/job/2002',
          },
        ],
      })
    }
    if (joined.startsWith('api repos/acme/api/compare/')) return BASE + '\n'
    if (joined.includes('/actions/jobs/')) return log
    throw new Error(`unexpected gh ${joined}`)
  }
}

function fakeFossa(revisions: Record<string, unknown>, orgId = 42, fossabot?: { status: number; body: unknown }): { client: FossaClient; urls: string[] } {
  const urls: string[] = []
  const client = new FossaClient({
    apiKey: 'key',
    endpoint: 'https://fossa.test',
    sleep: async () => {},
    fetch: async url => {
      urls.push(url)
      if (url.endsWith('/api/cli/organization')) return new Response(JSON.stringify({ organizationId: orgId }))
      if (url.includes('/api/fossabot/status')) {
        return new Response(JSON.stringify(fossabot?.body ?? {}), { status: fossabot?.status ?? 404 })
      }
      const locator = decodeURIComponent(url.match(/\/api\/cli\/([^/]+)\/issues/)?.[1] ?? '')
      const body = revisions[locator]
      return body ? new Response(JSON.stringify(body)) : new Response('{}', { status: 404 })
    },
  })
  return { client, urls }
}

const issue = (id: number, type = 'vulnerability') => ({ id, type, revisionId: `go+golang.org/x/net$v0.23.0`, cve: `CVE-${id}`, fixedIn: 'v0.33.0', priorityString: 'high' })

test('marks the issues the PR brought in', async () => {
  const project = 'custom+42/github.com/acme/api'
  const { client } = fakeFossa({
    [`${project}$${HEAD}`]: { status: 'SCANNED', count: 2, issues: [issue(1), issue(2, 'policy_conflict')] },
    [`${project}$${BASE}`]: { status: 'SCANNED', count: 1, issues: [issue(1)] },
  })
  const report = await prReport({ fossa: () => client, gh: fakeGh(), cwd: '.' }, 'acme/api', 166)

  assert.equal(report.status, 'scanned')
  assert.equal(report.projectLocator, project)
  assert.equal(report.baseSha, BASE)
  assert.equal(report.newCount, 1)
  assert.deepEqual(report.issues.map(one => [one.id, one.category, one.isNew]), [[1, 'vulnerability', false], [2, 'licensing', true]])
  assert.equal(report.issues[0]!.package, 'golang.org/x/net')
  assert.deepEqual(report.check, {
    name: 'check-fossa',
    state: 'FAILURE',
    url: 'https://github.com/acme/api/actions/runs/1001/job/2002',
    runId: '1001',
    jobId: '2002',
  })
})

test('finds a project with another name in the CI log', async () => {
  const project = 'custom+42/my-custom-name'
  const log = `2026-01-01T00:00:00.0000000Z     https://app.fossa.com/projects/custom%2b42%2fmy-custom-name/refs/branch/x/${HEAD}\n`
  const { client } = fakeFossa({ [`${project}$${HEAD}`]: { status: 'SCANNED', count: 0, issues: [] } })
  const report = await prReport({ fossa: () => client, gh: fakeGh(log), cwd: '.' }, 'acme/api', 166)
  assert.equal(report.projectLocator, project)
  assert.equal(report.status, 'scanned')
})

test('names both orgs when the key is from another org than CI uploads to', async () => {
  const log = `2026-01-01T00:00:00Z     https://app.fossa.com/projects/custom%2b42%2fgithub.com%2facme%2fapi/refs/branch/x/${HEAD}\n`
  const { client } = fakeFossa({}, 7)
  const result = await callTool({ fossa: () => client, gh: fakeGh(log), cwd: '.' }, 'fossa_pr_issues', { repo: 'acme/api', pr: 166 })
  assert.equal(result.isError, true)
  assert.match(firstText(result), /org 42 .*belongs to org 7/)
})

const npmIssue = (id: number) => ({ id, type: 'vulnerability', revisionId: 'npm+lodash$4.17.15', cve: 'CVE-2020-8203', fixedIn: '4.17.19' })

test('fossabot: Go issues are refused without a FOSSA call', async () => {
  const project = 'custom+42/github.com/acme/api'
  const { client, urls } = fakeFossa({ [`${project}$${HEAD}`]: { status: 'SCANNED', count: 1, issues: [issue(1)] } })
  const report = await prReport({ fossa: () => client, gh: fakeGh(), cwd: '.' }, 'acme/api', 166)
  assert.deepEqual(report.issues[0]!.fossabot, { canOpen: false, reason: 'fossabot does not fix go dependencies (only npm, mvn and pip)' })
  assert.equal(urls.filter(url => url.includes('/api/fossabot/')).length, 0)
})

test('fossabot: the feature flag answer is the reason', async () => {
  const project = 'custom+42/github.com/acme/api'
  const { client } = fakeFossa({ [`${project}$${HEAD}`]: { status: 'SCANNED', count: 1, issues: [npmIssue(1)] } }, 42, {
    status: 403,
    body: { message: 'someFeature is not enabled in this organization.' },
  })
  const report = await prReport({ fossa: () => client, gh: fakeGh(), cwd: '.' }, 'acme/api', 166)
  assert.deepEqual(report.issues[0]!.fossabot, { canOpen: false, reason: 'fossabot upgrade PRs are not enabled for this FOSSA organization' })
})

test('fossabot: a connected repo with credits can open a PR, with one status call', async () => {
  const project = 'custom+42/github.com/acme/api'
  const { client, urls } = fakeFossa({ [`${project}$${HEAD}`]: { status: 'SCANNED', count: 2, issues: [npmIssue(1), npmIssue(2)] } }, 42, {
    status: 200,
    body: { connected: true, creditLevel: 'available' },
  })
  const report = await prReport({ fossa: () => client, gh: fakeGh(), cwd: '.' }, 'acme/api', 166)
  assert.deepEqual(report.issues.map(one => one.fossabot), [{ canOpen: true }, { canOpen: true }])
  assert.equal(urls.filter(url => url.includes('/api/fossabot/status')).length, 1)
})

test('says so when CI never uploaded the commit', async () => {
  const { client } = fakeFossa({})
  const report = await prReport({ fossa: () => client, gh: fakeGh(), cwd: '.' }, 'acme/api', 166)
  assert.equal(report.status, 'not-analyzed')
})

test('without a base scan, issues are not told apart', async () => {
  const project = 'custom+42/github.com/acme/api'
  const { client } = fakeFossa({ [`${project}$${HEAD}`]: { status: 'SCANNED', count: 1, issues: [issue(1)] } })
  const report = await prReport({ fossa: () => client, gh: fakeGh(), cwd: '.' }, 'acme/api', 166)
  assert.equal(report.newCount, undefined)
  assert.equal(report.issues[0]!.isNew, undefined)
})

test('the report also travels as a JSON resource block', async () => {
  const project = 'custom+42/github.com/acme/api'
  const { client } = fakeFossa({ [`${project}$${HEAD}`]: { status: 'SCANNED', count: 1, issues: [issue(1)] } })
  const result = await callTool({ fossa: () => client, gh: fakeGh(), cwd: '.' }, 'fossa_pr_issues', { repo: 'acme/api', pr: 166 })
  const block = result.content[1] as { type: string; resource: { uri: string; mimeType: string; text: string } }
  assert.equal(block.type, 'resource')
  assert.equal(block.resource.mimeType, 'application/json')
  assert.deepEqual(JSON.parse(block.resource.text), JSON.parse(JSON.stringify(result.structuredContent)))
})

test('a push-only key fails with a clear message', async () => {
  const project = 'custom+42/github.com/acme/api'
  const { client } = fakeFossa({ [`${project}$${HEAD}`]: { status: 'SCANNED', count: 1 } })
  const result = await callTool({ fossa: () => client, gh: fakeGh(), cwd: '.' }, 'fossa_pr_issues', { repo: 'acme/api', pr: 166 })
  assert.equal(result.isError, true)
  assert.match(firstText(result), /push-only/)
})

test('ignore refuses a reason Core would refuse', async () => {
  const { client, urls } = fakeFossa({})
  const result = await callTool({ fossa: () => client, gh: fakeGh(), cwd: '.' }, 'fossa_ignore_issue', {
    id: 1,
    category: 'vulnerability',
    projectLocator: 'custom+1/x',
    reason: 'because',
    notes: 'n',
  })
  assert.equal(result.isError, true)
  assert.equal(urls.length, 0)
})

test('fossaCheckOf reads a running check and a status context', () => {
  assert.equal(fossaCheckOf([{ name: 'check-fossa', status: 'IN_PROGRESS', conclusion: '' }])?.state, 'PENDING')
  assert.equal(fossaCheckOf([{ context: 'fossa/license', state: 'FAILURE', targetUrl: 'https://app.fossa.com/x' }])?.state, 'FAILURE')
  assert.equal(fossaCheckOf([{ name: 'build', conclusion: 'SUCCESS' }]), undefined)
})
