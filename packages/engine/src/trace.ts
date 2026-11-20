/**
 * A page's trace (C20 E5): what the browser asked for while it loaded the
 * page, and what went wrong. One per page per browser profile, recorded by
 * the browser stage beside the suites.
 *
 * Kept small on purpose: no headers, no bodies, no cookies. A request is its
 * URL (cut), its kind, its status, when it started, how long the server took
 * to answer and how long it took in all, and its size on the wire.
 */
import type { Page, Request } from 'playwright-core'
import type { BrowserProfileId } from '@webtrax/protocol'

export interface TraceRequest {
  url: string
  /** Chromium's resource type: document, stylesheet, script, image, font, xhr, fetch, media, other. */
  type: string
  method: string
  /** Null when no response came back. */
  status: number | null
  /** Milliseconds from the start of the navigation to the request being sent. */
  start: number
  /** Milliseconds from sending the request to the first byte of the answer. */
  wait: number | null
  /** Milliseconds from the start of the request to its last byte. */
  duration: number | null
  /** Bytes on the wire (headers and body), when the browser reports them. */
  bytes: number | null
  /** Served by another site than the page's. */
  third_party: boolean
  /** Why the request failed, in the browser's words. */
  failed?: string
  /** The page could not be drawn until this had loaded. */
  blocking?: boolean
  /** This is what the Largest Contentful Paint drew. */
  lcp?: boolean
}

export interface PageTrace {
  url: string
  profile: BrowserProfileId
  status: number | null
  load_ms: number
  requests: TraceRequest[]
  /** How many requests the page made; `requests` holds the first `maxTraceRequests` of them. */
  requests_total: number
  /** Errors the page wrote to the console. */
  console: string[]
  /** Exceptions nothing caught. */
  errors: string[]
  /** The Largest Contentful Paint: when, what element, and the file it drew (an image), when the browser says. */
  lcp: { ms: number; element: string | null; url: string | null } | null
}

export const TRACE_LIMITS = { requests: 300, messages: 20, url: 300, text: 300 }
const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)
/** data: and blob: URLs are content, not addresses: only their kind is kept. */
const address = (url: string) => (/^(data|blob):/i.test(url) ? `${url.slice(0, url.indexOf(':'))}:` : cut(url, TRACE_LIMITS.url))

interface Seen { request: Request; failed?: string; bytes: Promise<number | null> }

/** Starts recording on a page that has not navigated yet; `finish` returns the trace. */
export function recordTrace(page: Page, url: string, profile: BrowserProfileId): { finish(status: number | null, loadMs: number): Promise<PageTrace> } {
  const seen: Seen[] = []
  const messages: string[] = []
  const errors: string[] = []
  let total = 0
  const note = (request: Request, failed?: string) => {
    total += 1
    if (seen.length >= TRACE_LIMITS.requests) return
    seen.push({ request, ...(failed !== undefined ? { failed } : {}), bytes: failed !== undefined ? Promise.resolve(null) : request.sizes().then((s) => s.responseHeadersSize + s.responseBodySize, () => null) })
  }
  page.on('requestfinished', (r) => note(r))
  page.on('requestfailed', (r) => note(r, r.failure()?.errorText ?? 'failed'))
  page.on('console', (m) => { if (m.type() === 'error' && messages.length < TRACE_LIMITS.messages) messages.push(cut(m.text(), TRACE_LIMITS.text)) })
  page.on('pageerror', (e) => { if (errors.length < TRACE_LIMITS.messages) errors.push(cut(e.message, TRACE_LIMITS.text)) })

  return {
    async finish(status, loadMs) {
      // What only the page knows: which files blocked rendering, and what the LCP was.
      const inPage = await page.evaluate(IN_PAGE).catch(() => ({ blocking: [] as string[], lcp: null as PageTrace['lcp'] }))
      const blocking = new Set(inPage.blocking)
      let host = ''
      try { host = new URL(url).host } catch { /* compared as written */ }
      const origin = Math.min(...seen.map((s) => s.request.timing().startTime).filter((t) => t > 0), Infinity)
      const requests: TraceRequest[] = []
      for (const s of seen) {
        const t = s.request.timing()
        const response = s.failed === undefined ? await s.request.response().catch(() => null) : null
        const full = s.request.url()
        let thirdParty = false
        try { thirdParty = /^https?:/i.test(full) && new URL(full).host !== host } catch { /* not a URL */ }
        requests.push({
          url: address(full), type: s.request.resourceType(), method: s.request.method(), status: response?.status() ?? null,
          start: Number.isFinite(origin) && t.startTime > 0 ? Math.max(0, Math.round(t.startTime - origin)) : 0,
          wait: t.responseStart >= 0 && t.requestStart >= 0 ? Math.round(t.responseStart - t.requestStart) : null,
          duration: t.responseEnd >= 0 ? Math.round(t.responseEnd) : null,
          bytes: await s.bytes, third_party: thirdParty,
          ...(s.failed !== undefined ? { failed: cut(s.failed, 120) } : {}),
          ...(blocking.has(full) ? { blocking: true } : {}),
          ...(inPage.lcp?.url && inPage.lcp.url === full ? { lcp: true } : {}),
        })
      }
      requests.sort((a, b) => a.start - b.start)
      return {
        url, profile, status, load_ms: Math.round(loadMs), requests, requests_total: total, console: messages, errors,
        lcp: inPage.lcp ? { ms: Math.round(inPage.lcp.ms), element: inPage.lcp.element ? cut(inPage.lcp.element, 120) : null, url: inPage.lcp.url ? address(inPage.lcp.url) : null } : null,
      }
    },
  }
}

/** Runs in the page: render-blocking resources and the LCP entry. Written without DOM types: the engine is a Node package. */
const IN_PAGE = async (): Promise<{ blocking: string[]; lcp: { ms: number; element: string | null; url: string | null } | null }> => {
  const g = globalThis as unknown as { performance: { getEntriesByType(t: string): { name: string; renderBlockingStatus?: string }[] }; PerformanceObserver: new (cb: (list: { getEntries(): unknown[] }) => void) => { observe(o: object): void }; setTimeout(f: () => void, ms: number): void }
  const blocking = g.performance.getEntriesByType('resource').filter((r) => r.renderBlockingStatus === 'blocking').map((r) => r.name)
  const lcp = await new Promise<{ ms: number; element: string | null; url: string | null } | null>((resolve) => {
    let last: { ms: number; element: string | null; url: string | null } | null = null
    try {
      new g.PerformanceObserver((list) => {
        for (const e of list.getEntries() as { startTime: number; url?: string; element?: { tagName: string; id?: string; className?: unknown } | null }[]) {
          const el = e.element
          const cls = el && typeof el.className === 'string' && el.className.trim() ? `.${el.className.trim().split(/\s+/).slice(0, 2).join('.')}` : ''
          last = { ms: e.startTime, element: el ? `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ''}${cls}` : null, url: e.url || null }
        }
      }).observe({ type: 'largest-contentful-paint', buffered: true })
    } catch { /* unsupported */ }
    g.setTimeout(() => resolve(last), 100)
  })
  return { blocking, lcp }
}
