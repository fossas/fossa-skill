import assert from 'node:assert/strict'
import { test } from 'node:test'

import { assertRepo, assertRunId, resolveRepo } from '../github.ts'

test('assertRepo accepts owner/name and rejects path traversal and flags', () => {
  assert.equal(assertRepo('fossas/fossa-skill'), 'fossas/fossa-skill')
  assert.equal(assertRepo('my-org.io/repo_1.2'), 'my-org.io/repo_1.2')
  for (const bad of ['fossas', 'fossas/skill/extra', '../../repos/x', 'owner/name?per_page=1', '--help', 'owner/name -R other']) {
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
