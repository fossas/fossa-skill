import assert from 'node:assert/strict'
import { test } from 'node:test'

import { FossaHostMismatch, assertRepo, assertRunId, projectFromJobLog, resolveRepo } from '../github.ts'
import { FossaClient, hostOf } from '../fossa.ts'

test('assertRepo accepts owner/name and rejects path traversal and flags', () => {
  assert.equal(assertRepo('fossas/fossa-skill'), 'fossas/fossa-skill')
  assert.equal(assertRepo('my-org.io/repo_1.2'), 'my-org.io/repo_1.2')
  for (const bad of ['fossas', 'fossas/skill/extra', '../../repos/x', '../repo', 'owner/..', './x', 'owner/.', 'owner/name?per_page=1', '--help', 'owner/name -R other']) {
    assert.throws(() => assertRepo(bad), /Invalid repository/, bad)
  }
})

test('assertRunId accepts digits only', () => {
  assert.equal(assertRunId('123456789'), '123456789')
  for (const bad of ['', '12a', '--failed', '1 --delete', '1;2']) {
    assert.throws(() => assertRunId(bad), /Invalid run id/, bad)
  }
})

test('resolveRepo shape-checks an explicit repo before any gh call', async () => {
  let called = false
  const run = async () => { called = true; return '' }
  await assert.rejects(() => resolveRepo(run, 'not a repo', '/tmp'), /Invalid repository/)
  assert.equal(called, false)
  assert.equal(await resolveRepo(run, 'fossas/fossa-skill', '/tmp'), 'fossas/fossa-skill')
  assert.equal(called, false)
})

test('projectFromJobLog takes the first FOSSA-host link and skips links on other hosts', async () => {
  const log = [
    'https://example.org/projects/not-fossa/refs/branch/main/abc',
    'https://APP.fossa.com/projects/custom%2B42%2Fgithub.com%2Fo%2Fr/refs/branch/main/abc',
    'https://app.fossa.com/projects/custom%2B42%2Fsecond/refs/branch/main/abc',
  ].join('\n')
  const run = async () => log
  assert.equal(await projectFromJobLog(run, 'o/r', '123', 'app.fossa.com'), 'custom+42/github.com/o/r')
  // Same log read with another configured host: the links are there but on the wrong host, which is reported, not hidden.
  await assert.rejects(projectFromJobLog(run, 'o/r', '123', 'fossa.example.internal'), FossaHostMismatch)
  assert.equal(hostOf('https://fossa.example.internal:8443/'), 'fossa.example.internal:8443')
  assert.equal(hostOf('fossa.acme.internal'), 'fossa.acme.internal') // scheme-less, as FossaClient accepts it
  assert.equal(new FossaClient({ apiKey: 'k', fetch: async () => new Response('{}') }).host, 'app.fossa.com')
  assert.equal(new FossaClient({ apiKey: 'k', endpoint: '', fetch: async () => new Response('{}') }).host, 'app.fossa.com') // set-but-empty FOSSA_ENDPOINT
  assert.equal(new FossaClient({ apiKey: 'k', endpoint: 'HTTPS://Fossa.Test/', fetch: async () => new Response('{}') }).host, 'fossa.test')
})

test('projectFromJobLog reports FOSSA links on another host instead of silently finding nothing', async () => {
  const run = async () => 'https://fossa.acme.io/projects/custom%2B42%2Fx/refs/branch/main/abc\nhttps://FOSSA.acme.io/projects/custom%2B42%2Fy/refs/branch/main/abc'
  await assert.rejects(projectFromJobLog(run, 'o/r', '1', 'app.fossa.com'), (err: unknown) => {
    assert.ok(err instanceof FossaHostMismatch)
    assert.deepEqual(err.hostsSeen, ['fossa.acme.io'])
    assert.match(err.message, /other than app\.fossa\.com \(log text, not verified\): fossa\.acme\.io\./)
    return true
  })
  // No FOSSA link at all is still "nothing found", not a mismatch.
  assert.equal(await projectFromJobLog(async () => 'no links here', 'o/r', '1', 'app.fossa.com'), undefined)
})

test('the host-mismatch note caps and truncates the hosts it repeats from the log', async () => {
  const hosts = ['a.example', 'b.example', 'c.example', 'd.example', `${'x'.repeat(150)}.example`]
  const log = hosts.map(host => `https://${host}/projects/p/refs/branch/main/abc`).join('\n')
  await assert.rejects(projectFromJobLog(async () => log, 'o/r', '1', 'app.fossa.com'), (err: unknown) => {
    assert.ok(err instanceof FossaHostMismatch)
    assert.equal(err.hostsSeen.length, 5)
    assert.match(err.message, /: a\.example, b\.example, c\.example and 2 more\./)
    assert.doesNotMatch(err.message, /x{101}/)
    assert.doesNotMatch(err.message, /set FOSSA_ENDPOINT to/)
    return true
  })
  const longOnly = `https://${'x'.repeat(150)}.example/projects/p/refs/branch/main/abc`
  await assert.rejects(projectFromJobLog(async () => longOnly, 'o/r', '1', 'app.fossa.com'), (err: Error) => {
    assert.match(err.message, /x{100}…/)
    return true
  })
})
