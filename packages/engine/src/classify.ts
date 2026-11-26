/** Turns fetch failures into protocol FetchError values, and decides what is worth one retry. */
import { ScopeDeniedError, TooManyRedirectsError } from '@webtrax/net-guard'
import type { FetchError } from '@webtrax/protocol'

/** undici wraps socket and DNS failures as `TypeError: fetch failed` with the real code on `cause`. */
function errorText(error: unknown): string {
  if (!(error instanceof Error)) return String(error)
  const cause = (error as { cause?: { code?: string; message?: string } }).cause
  return [error.name, error.message, (error as { code?: string }).code, cause?.code, cause?.message].filter(Boolean).join(' ')
}

export function classifyError(error: unknown): FetchError {
  if (error instanceof ScopeDeniedError) return 'blocked_by_scope'
  if (error instanceof TooManyRedirectsError) return 'connection_error'
  const text = errorText(error)
  if (/AbortError|TimeoutError|timeout|ETIMEDOUT|UND_ERR_(CONNECT|HEADERS|BODY)_TIMEOUT/i.test(text)) return 'timeout'
  if (/ENOTFOUND|EAI_AGAIN|EAI_NONAME|getaddrinfo/i.test(text)) return 'dns_error'
  if (/CERT|TLS|SSL|self[- ]signed|certificate/i.test(text)) return 'tls_error'
  if (/Invalid URL|ERR_INVALID_URL/i.test(text)) return 'invalid_url'
  return 'connection_error'
}

/** 5xx answers and network hiccups get one retry before they count (v1 semantics). */
export const isTransientStatus = (status: number) => status >= 500 && status < 600
export function isTransientError(error: unknown): boolean {
  if (error instanceof ScopeDeniedError || error instanceof TooManyRedirectsError) return false
  return /AbortError|TimeoutError|timeout|ECONNRESET|ETIMEDOUT|EAI_AGAIN|EPIPE|UND_ERR_SOCKET/i.test(errorText(error))
}

/** Seconds or an HTTP date, capped at `maxMs`; a default when absent or unreadable. */
export function retryAfterMs(header: string | null, now: number, maxMs = 120_000, fallbackMs = 5_000): number {
  if (!header) return fallbackMs
  const seconds = Number(header)
  const ms = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(header) - now
  return Number.isFinite(ms) ? Math.min(Math.max(ms, 0), maxMs) : fallbackMs
}

/**
 * Answers that say "not for you", not "not there": a sign-in is needed (401,
 * 407), the request was refused (403, 406), the page is withheld (451), or a
 * bot wall answered (LinkedIn's 999). The target may be perfectly fine for a
 * visitor, so it is never broken: it could not be verified (V2-COR-03).
 */
export const UNVERIFIABLE_STATUSES: ReadonlySet<number> = new Set([401, 403, 406, 407, 451, 999])
export const couldNotVerify = (o: { status: number | null; error?: FetchError | undefined }): boolean => !o.error && o.status !== null && UNVERIFIABLE_STATUSES.has(o.status)

/** What counts as a broken link target in the run summary (the links suite owns the findings, C05.4). */
export function isBrokenOutcome(o: { status: number | null; error?: FetchError | undefined }): boolean {
  if (o.error) return o.error !== 'rate_limited' && o.error !== 'robots_disallowed'
  return o.status !== null && o.status >= 400 && o.status !== 429 && !UNVERIFIABLE_STATUSES.has(o.status)
}

/**
 * A firewall or bot challenge, from what its vendor documents it sends, or
 * null. Only clear signals count: a challenge header, or a refusal (403, 405,
 * 429, 503) from the vendor's own edge. A plain 403 from a site is not a
 * wall: it may be a real page that wants a sign-in. The engine slows down
 * and pauses on a wall, then stops asking (`throttle.ts`); it never tries to
 * get past one.
 */
export function botWall(status: number | null, headers: Record<string, string> | undefined): string | null {
  if (status === null || !headers) return null
  const h = (name: string) => headers[name]?.toLowerCase() ?? ''
  if (h('cf-mitigated') === 'challenge') return 'Cloudflare'
  if (h('x-vercel-mitigated') === 'challenge' || h('x-vercel-mitigated') === 'deny') return 'Vercel'
  if (/^(challenge|captcha|block)$/.test(h('x-amzn-waf-action'))) return 'AWS WAF'
  if (h('x-datadome') || h('x-dd-b')) return status >= 400 ? 'DataDome' : null
  const refused = status === 403 || status === 405 || status === 429 || status === 503
  if (!refused) return null
  // Akamai's edge names itself only on answers it made; Cloudflare, Imperva and Sucuri stamp every
  // proxied answer, so their server headers on a 403 may be the site's own 403 and do not count.
  if (/^akamaighost/.test(h('server'))) return 'Akamai'
  if (headers['x-sucuri-block']) return 'Sucuri'
  return null
}
