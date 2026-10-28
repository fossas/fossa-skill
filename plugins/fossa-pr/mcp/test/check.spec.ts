import assert from 'node:assert/strict'
import { test } from 'node:test'

import { fossaCheckOf } from '../check.ts'

test('fossaCheckOf orders same-name runs by startedAt, so an older run that finished later cannot hide the newer one', () => {
  const older = { name: 'fossa', status: 'COMPLETED', conclusion: 'SUCCESS', startedAt: '2026-10-28T10:00:00Z', completedAt: '2026-10-28T10:30:00Z', detailsUrl: 'https://github.com/o/r/actions/runs/1/job/11' }
  const newer = { name: 'fossa', status: 'COMPLETED', conclusion: 'FAILURE', startedAt: '2026-10-28T10:10:00Z', completedAt: '2026-10-28T10:20:00Z', detailsUrl: 'https://github.com/o/r/actions/runs/2/job/22' }
  assert.equal(fossaCheckOf([older, newer])?.runId, '2')
  assert.equal(fossaCheckOf([newer, older])?.state, 'FAILURE')
  const running = { name: 'fossa', status: 'IN_PROGRESS', startedAt: '2026-10-28T10:40:00Z', detailsUrl: 'https://github.com/o/r/actions/runs/3/job/33' }
  assert.equal(fossaCheckOf([older, running])?.state, 'PENDING')
})
