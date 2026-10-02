// Finds the FOSSA check in a PR's status rollup. No Node imports, so the
// Claude Code mod can import it too.

import type { FossaCheck } from '../types/index.d.ts'

export type RollupItem = {
  name?: string
  context?: string
  status?: string
  conclusion?: string
  state?: string
  detailsUrl?: string
  targetUrl?: string
  startedAt?: string
  completedAt?: string
}

// The FOSSA scan check: a check whose name says fossa, but not one of
// fossabot's own checks (such as "fossabot: review"). When several
// match, the latest counts, so an older green run cannot hide a newer red one.
export function fossaCheckOf(rollup: readonly RollupItem[]): FossaCheck | undefined {
  const when = (one: RollupItem) => Date.parse(one.completedAt || one.startedAt || '') || 0
  const item = rollup
    .filter(one => {
      const name = one.name ?? one.context ?? ''
      return /fossa/i.test(name) && !/fossabot/i.test(name)
    })
    .reduce<RollupItem | undefined>((latest, one) => (!latest || when(one) > when(latest) ? one : latest), undefined)
  if (!item) return undefined
  const url = item.detailsUrl ?? item.targetUrl
  const ids = url?.match(/\/actions\/runs\/(\d+)(?:\/job\/(\d+))?/)
  const state = item.conclusion || (item.status && item.status !== 'COMPLETED' ? 'PENDING' : item.state) || 'UNKNOWN'
  return { name: item.name ?? item.context ?? 'fossa', state, url, runId: ids?.[1], jobId: ids?.[2] }
}
