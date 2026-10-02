// FOSSA API client that is gentle with Core.
//
// Every request goes through one gate: at most MAX_IN_FLIGHT requests at a
// time, and at least MIN_INTERVAL_MS between request starts. GET results are
// cached, and two callers that ask for the same URL at the same time share
// one request. A scan that is still running is retried with growing waits,
// then given up on, so nothing here polls Core without end.

import type { Category } from '../types/index.d.ts'

export type CliIssue = {
  id: number
  type: string
  revisionId?: string
  license?: string
  issueDashURL?: string
  cve?: string
  fixedIn?: string
  priorityString?: string
}

export type CliIssues = { status: 'WAITING' | 'SCANNED'; count: number; issues?: CliIssue[] }

export type IssuesResult =
  | { kind: 'scanned'; count: number; issues: CliIssue[]; hasDetails: boolean }
  | { kind: 'waiting' }
  | { kind: 'not-found' }

export const IGNORE_REASONS = [
  'Fixed',
  'Under_investigation',
  'Vulnerable_code_not_present',
  'Vulnerable_code_cannot_be_controlled',
  'Component_not_present',
  'Vulnerable_code_not_in_execute_path',
  'Inline_mitigations_already_exist',
  'incorrect_data_found',
  'other',
] as const

export type IgnoreReason = (typeof IGNORE_REASONS)[number]

export class FossaApiError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

type Fetch = (url: string, init: RequestInit) => Promise<Response>
type Sleep = (ms: number) => Promise<void>

export type ClientOptions = {
  apiKey: string
  endpoint?: string
  fetch?: Fetch
  sleep?: Sleep
  now?: () => number
  minIntervalMs?: number
  maxInFlight?: number
  cacheTtlMs?: number
  scanWaitsMs?: number[]
}

const MIN_INTERVAL_MS = 1000
const MAX_IN_FLIGHT = 2
const CACHE_TTL_MS = 10 * 60 * 1000
// Waits before each new look at a scan that is still running: about 21 seconds in all.
const SCAN_WAITS_MS = [3000, 6000, 12000]
const MAX_RETRY_AFTER_MS = 60_000
const SERVER_ERROR_WAITS_MS = [2000, 5000]

const realSleep: Sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

export class FossaClient {
  private apiKey: string
  private endpoint: string
  private fetch: Fetch
  private sleep: Sleep
  private now: () => number
  private minIntervalMs: number
  private maxInFlight: number
  private cacheTtlMs: number
  private scanWaitsMs: number[]

  private inFlight = 0
  private nextStartAt = 0
  private queue: Array<() => void> = []
  private cache = new Map<string, { expiresAt: number; value: unknown }>()
  private pending = new Map<string, Promise<unknown>>()
  private orgId: number | undefined

  // The number of HTTP requests sent to Core, for tests and for the debug line.
  requestCount = 0

  constructor(options: ClientOptions) {
    this.apiKey = options.apiKey
    this.endpoint = (options.endpoint ?? 'https://app.fossa.com').replace(/\/+$/, '')
    this.fetch = options.fetch ?? ((url, init) => fetch(url, init))
    this.sleep = options.sleep ?? realSleep
    this.now = options.now ?? Date.now
    this.minIntervalMs = options.minIntervalMs ?? MIN_INTERVAL_MS
    this.maxInFlight = options.maxInFlight ?? MAX_IN_FLIGHT
    this.cacheTtlMs = options.cacheTtlMs ?? CACHE_TTL_MS
    this.scanWaitsMs = options.scanWaitsMs ?? SCAN_WAITS_MS
  }

  async organizationId(): Promise<number> {
    if (this.orgId === undefined) {
      const org = await this.get<{ organizationId: number }>('/api/cli/organization', { ttlMs: Infinity })
      this.orgId = org.organizationId
    }
    return this.orgId
  }

  // The issues of one revision, as `fossa test` reads them. A push-only key
  // gets the count without details; `hasDetails` says which.
  async revisionIssues(revisionLocator: string): Promise<IssuesResult> {
    const path = `/api/cli/${encodeURIComponent(revisionLocator)}/issues`
    for (let attempt = 0; ; attempt++) {
      let body: CliIssues
      try {
        body = await this.get<CliIssues>(path, { cacheIf: (b: CliIssues) => b.status === 'SCANNED' })
      } catch (err) {
        if (err instanceof FossaApiError && err.status === 404) return { kind: 'not-found' }
        throw err
      }
      if (body.status === 'SCANNED') {
        return { kind: 'scanned', count: body.count, issues: body.issues ?? [], hasDetails: body.issues !== undefined }
      }
      const wait = this.scanWaitsMs[attempt]
      if (wait === undefined) return { kind: 'waiting' }
      await this.sleep(wait)
    }
  }

  // Core finds a single issue only within a revision: with the project alone it answers 404.
  async issue(id: number, category: Category, projectLocator: string, revision: string): Promise<unknown> {
    const query = new URLSearchParams({ category, 'scope[type]': 'project', 'scope[id]': projectLocator, 'scope[revision]': revision })
    return this.get(`/api/v2/issues/${id}?${query}`)
  }

  async ignoreIssue(args: {
    id: number
    category: Category
    projectLocator: string
    reason?: IgnoreReason
    notes: string
  }): Promise<unknown> {
    const query = new URLSearchParams({
      category: args.category,
      'scope[type]': 'project',
      'scope[id]': args.projectLocator,
      'ids[]': String(args.id),
    })
    const body = { type: 'ignore', notes: args.notes, ...(args.reason && { reason: args.reason }) }
    const result = await this.send('PUT', `/api/v2/issues?${query}`, body)
    this.forgetProject(args.projectLocator)
    return result
  }

  // Whether fossabot can open PRs for the project's repository. One cached call.
  async fossabotStatus(projectLocator: string): Promise<{ connected: boolean; creditLevel: string | null }> {
    return this.get(`/api/fossabot/status?${new URLSearchParams({ projectLocator })}`)
  }

  async requestFixPr(id: number, projectLocator: string, fix?: 'partial' | 'complete'): Promise<unknown> {
    return this.send('POST', `/api/fossabot/issues/${id}/dependency-upgrade-pr`, {
      projectLocator,
      ...(fix && { fix }),
    })
  }

  // An ignore changes what every revision of the project reports, so every
  // cached answer for the project goes.
  forgetProject(projectLocator: string): void {
    const encoded = encodeURIComponent(projectLocator)
    for (const key of this.cache.keys()) {
      if (key.includes(encoded)) this.cache.delete(key)
    }
  }

  private async get<T>(path: string, opts: { ttlMs?: number; cacheIf?: (body: T) => boolean } = {}): Promise<T> {
    const hit = this.cache.get(path)
    if (hit && hit.expiresAt > this.now()) return hit.value as T

    const shared = this.pending.get(path)
    if (shared) return shared as Promise<T>

    const request = this.send<T>('GET', path)
      .then(body => {
        if (!opts.cacheIf || opts.cacheIf(body)) {
          this.cache.set(path, { expiresAt: this.now() + (opts.ttlMs ?? this.cacheTtlMs), value: body })
        }
        return body
      })
      .finally(() => this.pending.delete(path))
    this.pending.set(path, request)
    return request
  }

  private async send<T>(method: string, path: string, body?: unknown): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      const response = await this.gated(() =>
        this.fetch(this.endpoint + path, {
          method,
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            Accept: 'application/json',
            ...(body !== undefined && { 'Content-Type': 'application/json' }),
          },
          ...(body !== undefined && { body: JSON.stringify(body) }),
        }),
      )
      if (response.ok) {
        const text = await response.text()
        return (text ? JSON.parse(text) : {}) as T
      }

      const wait = retryWait(response, attempt)
      if (wait === undefined) {
        const text = await response.text().catch(() => '')
        throw new FossaApiError(response.status, `${method} ${path.split('?')[0]} failed with ${response.status}: ${text.slice(0, 300)}`)
      }
      await response.body?.cancel()
      await this.sleep(wait)
    }
  }

  // Runs `start` once a slot is free and the pacing allows another request.
  private async gated<T>(start: () => Promise<T>): Promise<T> {
    while (this.inFlight >= this.maxInFlight) {
      await new Promise<void>(resolve => this.queue.push(resolve))
    }
    this.inFlight++
    try {
      const delay = this.nextStartAt - this.now()
      this.nextStartAt = Math.max(this.now(), this.nextStartAt) + this.minIntervalMs
      if (delay > 0) await this.sleep(delay)
      this.requestCount++
      return await start()
    } finally {
      this.inFlight--
      this.queue.shift()?.()
    }
  }
}

function retryWait(response: Response, attempt: number): number | undefined {
  if (response.status === 429 && attempt < 2) {
    const seconds = Number(response.headers.get('retry-after'))
    return Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds * 1000, MAX_RETRY_AFTER_MS) : 5000
  }
  if (response.status >= 502 && response.status <= 504) return SERVER_ERROR_WAITS_MS[attempt]
  return undefined
}

// How FOSSA groups issue types into its three categories.
export function categoryOf(type: string): Category {
  if (type === 'vulnerability' || type === 'malware') return 'vulnerability'
  if (type === 'outdated_dependency' || type === 'blacklisted_dependency' || type.startsWith('risk_')) return 'quality'
  return 'licensing'
}

// `go+golang.org/x/net$v0.23.0` -> { fetcher: 'go', name: 'golang.org/x/net', version: 'v0.23.0' }
export function parseLocator(locator: string): { fetcher: string; name: string; version?: string } {
  const plus = locator.indexOf('+')
  const fetcher = plus === -1 ? '' : locator.slice(0, plus)
  const rest = plus === -1 ? locator : locator.slice(plus + 1)
  const dollar = rest.lastIndexOf('$')
  return dollar === -1
    ? { fetcher, name: rest }
    : { fetcher, name: rest.slice(0, dollar), version: rest.slice(dollar + 1) }
}
