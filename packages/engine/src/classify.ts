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

/** What counts as a broken link target in the run summary (the links suite owns the findings, C05.4). */
export function isBrokenOutcome(o: { status: number | null; error?: FetchError | undefined }): boolean {
  if (o.error) return o.error !== 'rate_limited' && o.error !== 'robots_disallowed'
  return o.status !== null && o.status >= 400 && o.status !== 429
}
