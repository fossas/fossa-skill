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
}

export function fossaCheckOf(rollup: readonly RollupItem[]): FossaCheck | undefined {
  const item = rollup.find(one => /fossa/i.test(one.name ?? one.context ?? ''))
  if (!item) return undefined
  const url = item.detailsUrl ?? item.targetUrl
  const ids = url?.match(/\/actions\/runs\/(\d+)(?:\/job\/(\d+))?/)
  const state = item.conclusion || (item.status && item.status !== 'COMPLETED' ? 'PENDING' : item.state) || 'UNKNOWN'
  return { name: item.name ?? item.context ?? 'fossa', state, url, runId: ids?.[1], jobId: ids?.[2] }
}
