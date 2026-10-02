import assert from 'node:assert/strict'
import { test } from 'node:test'

import { FossaClient, categoryOf, parseLocator } from '../fossa.ts'

type Call = { method: string; url: string; at: number; body?: string }

// A fake Core and a fake clock: sleep moves the clock, so the tests run at once.
function harness(answer: (call: Call) => { status?: number; body?: unknown; headers?: Record<string, string> }) {
  let clock = 0
  const calls: Call[] = []
  const client = new FossaClient({
    apiKey: 'key',
    endpoint: 'https://fossa.test',
    now: () => clock,
    sleep: async ms => {
      clock += ms
    },
    fetch: async (url, init) => {
      const call = { method: String(init.method), url, at: clock, body: init.body as string | undefined }
      calls.push(call)
      const { status = 200, body = {}, headers = {} } = answer(call)
      return new Response(JSON.stringify(body), { status, headers })
    },
  })
  return { client, calls, advance: (ms: number) => (clock += ms) }
}

const SCANNED = { status: 'SCANNED', count: 1, issues: [{ id: 7, type: 'vulnerability', revisionId: 'go+golang.org/x/net$v0.23.0' }] }

test('sends the key as a bearer token', async () => {
  let auth = ''
  const client = new FossaClient({
    apiKey: 'secret',
    endpoint: 'https://fossa.test',
    sleep: async () => {},
    fetch: async (_url, init) => {
      auth = new Headers(init.headers).get('authorization') ?? ''
      return new Response(JSON.stringify({ organizationId: 1 }))
    },
  })
  assert.equal(await client.organizationId(), 1)
  assert.equal(auth, 'Bearer secret')
})

test('asks for the org id once', async () => {
  const { client, calls } = harness(() => ({ body: { organizationId: 42 } }))
  assert.equal(await client.organizationId(), 42)
  assert.equal(await client.organizationId(), 42)
  assert.equal(calls.length, 1)
})

test('caches a scanned revision and shares a request already running', async () => {
  const { client, calls } = harness(() => ({ body: SCANNED }))
  const [a, b] = await Promise.all([client.revisionIssues('custom+1/p$abc'), client.revisionIssues('custom+1/p$abc')])
  await client.revisionIssues('custom+1/p$abc')
  assert.equal(calls.length, 1)
  assert.deepEqual(a, b)
  assert.equal(a.kind, 'scanned')
  assert.ok(calls[0]!.url.endsWith('/api/cli/custom%2B1%2Fp%24abc/issues'))
})

test('looks again after the cache time', async () => {
  const { client, calls, advance } = harness(() => ({ body: SCANNED }))
  await client.revisionIssues('custom+1/p$abc')
  advance(10 * 60 * 1000 + 1)
  await client.revisionIssues('custom+1/p$abc')
  assert.equal(calls.length, 2)
})

test('waits longer each time a scan is still running, then gives up', async () => {
  const { client, calls } = harness(() => ({ body: { status: 'WAITING', count: 0 } }))
  const result = await client.revisionIssues('custom+1/p$abc')
  assert.equal(result.kind, 'waiting')
  // One look, then three more after 3, 6 and 12 seconds.
  assert.deepEqual(calls.map(call => call.at), [0, 3000, 9000, 21000])
})

test('a scan that finishes while it waits is returned', async () => {
  let n = 0
  const { client } = harness(() => ({ body: ++n < 3 ? { status: 'WAITING', count: 0 } : SCANNED }))
  const result = await client.revisionIssues('custom+1/p$abc')
  assert.equal(result.kind, 'scanned')
})

test('a revision Core does not know is not-found', async () => {
  const { client } = harness(() => ({ status: 404, body: { message: 'not found' } }))
  assert.deepEqual(await client.revisionIssues('custom+1/p$abc'), { kind: 'not-found' })
})

test('a push-only key gets the count without details', async () => {
  const { client } = harness(() => ({ body: { status: 'SCANNED', count: 3 } }))
  const result = await client.revisionIssues('custom+1/p$abc')
  assert.deepEqual(result, { kind: 'scanned', count: 3, issues: [], hasDetails: false })
})

test('keeps at least one second between requests and at most two at once', async () => {
  let open = 0
  let most = 0
  let clock = 0
  const starts: number[] = []
  const client = new FossaClient({
    apiKey: 'key',
    endpoint: 'https://fossa.test',
    now: () => clock,
    sleep: async ms => {
      clock += ms
    },
    fetch: async () => {
      starts.push(clock)
      open++
      most = Math.max(most, open)
      await new Promise(resolve => setTimeout(resolve, 5))
      open--
      return new Response(JSON.stringify(SCANNED))
    },
  })
  await Promise.all(['a', 'b', 'c', 'd', 'e'].map(sha => client.revisionIssues(`custom+1/p$${sha}`)))
  assert.equal(starts.length, 5)
  assert.ok(most <= 2, `at most 2 at once, saw ${most}`)
  for (let i = 1; i < starts.length; i++) assert.ok(starts[i]! - starts[i - 1]! >= 1000, `gap ${i}: ${starts[i]! - starts[i - 1]!}`)
})

test('follows Retry-After on 429, then succeeds', async () => {
  let n = 0
  const { client, calls } = harness(() => (++n === 1 ? { status: 429, headers: { 'retry-after': '7' } } : { body: SCANNED }))
  const result = await client.revisionIssues('custom+1/p$abc')
  assert.equal(result.kind, 'scanned')
  assert.equal(calls[1]!.at - calls[0]!.at, 7000)
})

test('gives up on a 500 at once and on a 503 after two retries', async () => {
  const fivehundred = harness(() => ({ status: 500 }))
  await assert.rejects(fivehundred.client.organizationId(), /failed with 500/)
  assert.equal(fivehundred.calls.length, 1)

  const unavailable = harness(() => ({ status: 503 }))
  await assert.rejects(unavailable.client.organizationId(), /failed with 503/)
  assert.equal(unavailable.calls.length, 3)
})

test('ignore sends the documented query and body, and forgets the project', async () => {
  const { client, calls } = harness(call => ({ body: call.method === 'PUT' ? { count: 1 } : SCANNED }))
  await client.revisionIssues('custom+1/github.com/o/r$abc')
  await client.ignoreIssue({ id: 7, category: 'vulnerability', projectLocator: 'custom+1/github.com/o/r', reason: 'other', notes: 'n' })
  await client.revisionIssues('custom+1/github.com/o/r$abc')

  const put = calls.find(call => call.method === 'PUT')!
  const url = new URL(put.url)
  assert.equal(url.pathname, '/api/v2/issues')
  assert.equal(url.searchParams.get('category'), 'vulnerability')
  assert.equal(url.searchParams.get('scope[type]'), 'project')
  assert.equal(url.searchParams.get('scope[id]'), 'custom+1/github.com/o/r')
  assert.equal(url.searchParams.get('ids[]'), '7')
  assert.deepEqual(JSON.parse(put.body!), { type: 'ignore', notes: 'n', reason: 'other' })
  // The issues were fetched again after the ignore.
  assert.equal(calls.filter(call => call.method === 'GET').length, 2)
})

test('a single issue is looked up within its revision', async () => {
  const { client, calls } = harness(() => ({ body: { id: 7 } }))
  await client.issue(7, 'vulnerability', 'custom+1/github.com/o/r', 'abc123')
  const url = new URL(calls[0]!.url)
  assert.equal(url.pathname, '/api/v2/issues/7')
  assert.equal(url.searchParams.get('scope[type]'), 'project')
  assert.equal(url.searchParams.get('scope[id]'), 'custom+1/github.com/o/r')
  assert.equal(url.searchParams.get('scope[revision]'), 'abc123')
})

test('categoryOf follows Core', () => {
  assert.equal(categoryOf('vulnerability'), 'vulnerability')
  assert.equal(categoryOf('malware'), 'vulnerability')
  assert.equal(categoryOf('outdated_dependency'), 'quality')
  assert.equal(categoryOf('risk_native_code'), 'quality')
  assert.equal(categoryOf('policy_conflict'), 'licensing')
  assert.equal(categoryOf('unlicensed_dependency'), 'licensing')
})

test('parseLocator splits a dependency locator', () => {
  assert.deepEqual(parseLocator('go+golang.org/x/net$v0.23.0'), { fetcher: 'go', name: 'golang.org/x/net', version: 'v0.23.0' })
  assert.deepEqual(parseLocator('npm+@scope/pkg$1.2.3'), { fetcher: 'npm', name: '@scope/pkg', version: '1.2.3' })
  assert.deepEqual(parseLocator('custom+1/x'), { fetcher: 'custom', name: '1/x' })
})
