/**
 * fetch() for the crawler that can only reach what the scope policy allows
 * (port of v1 apps/legacy/runner/lib/guarded-fetch.js).
 *
 * - The URL is checked before anything is sent (scheme, denied hosts, IP
 *   literals, which skip DNS).
 * - Every connection resolves through the guarded lookup, so hostnames are
 *   checked against the address actually used.
 * - Redirects are followed by hand, one hop at a time, and every hop is
 *   checked the same way. The chain is returned, because the crawler reports
 *   it (PageRecord.redirect_chain).
 * - `originHeaders` (a protected preview's bypass header, say) go only to
 *   that origin: added on each hop that is on it, never on a hop a redirect
 *   took elsewhere.
 */
import { Agent, fetch as undiciFetch, Headers, type RequestInit, type Response } from 'undici'
import { createGuardedLookup, type LookupFunction } from './lookup'
import { assertAllowed, ScopeDeniedError, ScopePolicy, type ScopePolicyConfig } from './policy'

export interface GuardedFetchOptions {
  policy?: ScopePolicy | ScopePolicyConfig
  /** TCP and TLS connect timeout. Default 10 s. */
  connectTimeoutMs?: number
  /** Redirect hops followed before giving up. Default 10. */
  maxRedirects?: number
  /** Injected DNS for tests; defaults to the system resolver. */
  lookup?: LookupFunction
}

export interface RedirectHop { url: string; status: number }

export interface GuardedRequestInit extends RequestInit {
  /** Headers sent only to `origin` (scheme, host and port), on every hop that is on it, and on no other. */
  originHeaders?: { origin: string; headers: Record<string, string> }
}

export interface FetchResult {
  response: Response
  /** The URL that produced `response`, after redirects. */
  url: string
  /** Every redirect response on the way, in order. Empty when there was none. */
  chain: RedirectHop[]
}

export class TooManyRedirectsError extends Error {
  readonly code = 'ETOOMANYREDIRECTS'
  constructor(readonly chain: RedirectHop[]) {
    super(`too many redirects (${chain.length})`)
    this.name = 'TooManyRedirectsError'
  }
}

const isRedirect = (status: number) => status >= 300 && status < 400

/** undici reports a refused lookup as `TypeError: fetch failed` with our error as the cause; surface the cause. */
async function fetchHop(url: string, init: RequestInit): Promise<Response> {
  try {
    return await undiciFetch(url, init)
  } catch (error) {
    const cause = (error as { cause?: unknown }).cause
    if (cause instanceof ScopeDeniedError) throw cause
    throw error
  }
}

export interface GuardedFetch {
  /** Fetches `url`, following redirects unless `init.redirect` is `'manual'`. */
  (url: string, init?: GuardedRequestInit): Promise<FetchResult>
  readonly policy: ScopePolicy
  /** Closes pooled connections. */
  close(): Promise<void>
}

export function createGuardedFetch(options: GuardedFetchOptions = {}): GuardedFetch {
  const policy = options.policy instanceof ScopePolicy ? options.policy : new ScopePolicy(options.policy)
  const maxRedirects = options.maxRedirects ?? 10
  const dispatcher = new Agent({
    connect: { lookup: createGuardedLookup(policy, options.lookup), timeout: options.connectTimeoutMs ?? 10_000 },
  })

  const guarded = async (url: string, { originHeaders, ...init }: GuardedRequestInit = {}): Promise<FetchResult> => {
    assertAllowed(policy.checkUrl(url))
    let current = new URL(url).toString()
    let method = (init.method ?? 'GET').toUpperCase()
    let body = init.body
    const chain: RedirectHop[] = []
    for (;;) {
      const hopInit: RequestInit = { ...init, method, dispatcher, redirect: 'manual' }
      if (originHeaders && new URL(current).origin === originHeaders.origin) {
        const headers = new Headers(init.headers ?? {})
        for (const [k, v] of Object.entries(originHeaders.headers)) headers.set(k, v)
        hopInit.headers = headers
      }
      if (body === undefined) delete hopInit.body
      else hopInit.body = body
      const response = await fetchHop(current, hopInit)
      const location = response.headers.get('location')
      if (init.redirect === 'manual' || !isRedirect(response.status) || !location) return { response, url: current, chain }
      chain.push({ url: current, status: response.status })
      if (chain.length > maxRedirects) {
        await response.body?.cancel().catch(() => {})
        throw new TooManyRedirectsError(chain)
      }
      const next = new URL(location, current).toString()
      assertAllowed(policy.checkUrl(next))
      // 303, and 301/302 for anything but GET/HEAD, switch to GET without a body, as browsers do.
      if (response.status === 303 || ((response.status === 301 || response.status === 302) && method !== 'GET' && method !== 'HEAD')) {
        method = method === 'HEAD' ? 'HEAD' : 'GET'
        body = undefined
      }
      await response.body?.cancel().catch(() => {})
      current = next
    }
  }

  return Object.assign(guarded, { policy, close: () => dispatcher.close() })
}
