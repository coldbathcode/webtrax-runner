/**
 * Every request the engine makes goes through here: the host throttle, a
 * per-request timeout tied to the job's abort signal, the identifying
 * headers, one retry for transient failures (v1 semantics), Retry-After on
 * 429/503, firewalls and bot challenges (pause, then stop asking that host;
 * never an attempt to get past one), and for link checks HEAD with a GET
 * fallback. Good answers feed the throttle, so the scan's own site can go as
 * fast as it answers well. The network itself is
 * @webtrax/net-guard, so scope, redirects and DNS are checked underneath.
 *
 * Pages follow redirects one hop at a time, so the engine can stop at a hop
 * whose target it already has (one fetch per URL per scan).
 */
import { discardBody, readTextCapped, type GuardedFetch } from '@webtrax/net-guard'
import type { FetchError, RedirectHop } from '@webtrax/protocol'
import { botWall, classifyError, isTransientError, isTransientStatus, retryAfterMs } from './classify'
import type { HostThrottle, ThrottleClock, WallVerdict } from './throttle'

export interface Outcome {
  url: string
  /** Where the redirects ended, or the known page they were stopped at. */
  finalUrl: string
  /** Status of the last response received (a 3xx when stopped at a known page). */
  status: number | null
  error?: FetchError
  chain: RedirectHop[]
  contentType?: string
  headers?: Record<string, string>
  body?: string
  truncated?: boolean
  timing: { ttfb: number; total: number }
  /** How many HTTP requests this outcome took (redirect hops, retries and HEAD→GET included). */
  requests: number
  /**
   * A firewall or bot challenge answered (`by`: the vendor, when known), or the
   * host had walled so often that this URL was not asked for at all
   * (`skipped`). Always with `error: 'rate_limited'`: could not verify, never broken.
   */
  wall?: { by: string | null; skipped: boolean }
}

export interface RequesterOptions {
  fetch: GuardedFetch
  throttle: HostThrottle
  clock: ThrottleClock
  userAgent: string
  rps: number
  signal: AbortSignal
  timeoutMs: number
  retryDelayMs: number
  maxBodyBytes: number
  /** Attempts on 429 / 503 with Retry-After before giving up as `rate_limited`. */
  rateLimitAttempts: number
  maxRedirects?: number
  onRateLimited?: (host: string) => void
  /** A wall answered for `host`: the caller records it and says whether to pause and try once more, or stop. */
  onWalled?: (host: string, by: string) => WallVerdict
  /** A URL not asked for because its host had walled too often. */
  onWallSkip?: (host: string) => void
  /** The job's auth headers, for the target's own site only (net-guard drops them on any other hop). */
  originHeaders?: { origin: string | readonly string[]; headers: Record<string, string> }
}

/**
 * A HEAD that failed says little: servers and CDNs answer HEAD with 400, 403,
 * 404, 405, 500 or 503, hang, or reset the connection, and serve the same URL
 * to a GET. So every HEAD failure is confirmed with one GET before a link is
 * called broken (V2-COR-04). Rate limiting is not a failure: it is waited out.
 */
const headFailed = (a: { status: number | null; retryAfter?: string | null | undefined }) =>
  a.status === null || (a.status >= 400 && a.status !== 429 && !(a.status === 503 && !!a.retryAfter))
const HTML = /text\/html|application\/xhtml\+xml/i

/** One exchange, with what the retry logic needs to know. */
type Attempt = Outcome & { retryAfter?: string | null; transientError?: boolean; location?: string | null; wireMs?: number; wallBy?: string; /** The host that walled (a redirect hop may be on another). */ wallHost?: string }

interface OnceOptions { method: 'GET' | 'HEAD'; referer?: string | undefined; read: (contentType: string) => boolean; maxBytes: number; manual: boolean; userAgent?: string; /** Read 4xx and 5xx bodies too (an error page can be the evidence). */ readErrors?: boolean }

const headersObject = (h: { forEach(cb: (value: string, key: string) => void): void }) => {
  const out: Record<string, string> = {}
  h.forEach((value, key) => { out[key] = value })
  return out
}

const isRedirect = (status: number | null) => status !== null && status >= 300 && status < 400

export function createRequester(o: RequesterOptions) {
  const maxRedirects = o.maxRedirects ?? 10
  const headers = (referer?: string, userAgent: string = o.userAgent) => ({
    'user-agent': userAgent,
    accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
    'accept-language': 'en;q=0.9,*;q=0.5',
    ...(referer ? { referer } : {}),
  })

  /** One HTTP exchange; never throws. */
  async function once(url: string, x: OnceOptions): Promise<Attempt> {
    const started = o.clock.now()
    const host = new URL(url).host
    if (o.throttle.walled(host)) {
      o.onWallSkip?.(host)
      return { url, finalUrl: url, status: null, error: 'rate_limited', chain: [], requests: 0, timing: { ttfb: 0, total: 0 }, wall: { by: null, skipped: true } }
    }
    await o.throttle.wait(host, o.rps, o.signal)
    const sent = o.clock.now()
    const signal = AbortSignal.any([o.signal, AbortSignal.timeout(o.timeoutMs)])
    try {
      const { response, url: finalUrl, chain } = await o.fetch(url, { method: x.method, headers: headers(x.referer, x.userAgent), signal, ...(x.manual ? { redirect: 'manual' as const } : {}), ...(o.originHeaders ? { originHeaders: o.originHeaders } : {}) })
      const ttfb = o.clock.now() - started
      const contentType = response.headers.get('content-type') ?? undefined
      const base = {
        url, finalUrl, status: response.status, chain, headers: headersObject(response.headers), requests: 1 + chain.length,
        retryAfter: response.headers.get('retry-after'), location: response.headers.get('location'), ...(contentType ? { contentType } : {}),
        wireMs: o.clock.now() - sent,
      }
      const wallBy = botWall(response.status, base.headers)
      if (wallBy) {
        await discardBody(response)
        return { ...base, wallBy, wallHost: host, timing: { ttfb, total: o.clock.now() - started } }
      }
      if (response.status !== 429 && response.status < 500) o.throttle.observe(host, base.wireMs)
      if (x.method === 'GET' && (response.status < 300 || (x.readErrors && response.status >= 400)) && x.read(contentType ?? '')) {
        const { text, truncated } = await readTextCapped(response, x.maxBytes)
        return { ...base, body: text, truncated, timing: { ttfb, total: o.clock.now() - started } }
      }
      await discardBody(response)
      return { ...base, timing: { ttfb, total: o.clock.now() - started } }
    } catch (error) {
      const elapsed = o.clock.now() - started
      return { url, finalUrl: url, status: null, error: classifyError(error), chain: [], requests: 1, timing: { ttfb: elapsed, total: elapsed }, transientError: isTransientError(error) }
    }
  }

  /** Retries once on a transient failure, and waits out Retry-After on 429 / 503. */
  async function withRetries(attempt: () => Promise<Attempt>): Promise<Outcome> {
    let requests = 0
    let retriedTransient = false
    let rateLimited = 0
    let walls = 0
    for (;;) {
      const r = await attempt()
      requests += r.requests
      if (r.wall?.skipped) return strip({ ...r, requests })
      if (r.wallBy && !o.signal.aborted) {
        const verdict = o.onWalled?.(r.wallHost ?? new URL(r.url).host, r.wallBy) ?? 'stop'
        // One more try after the pause the throttle now holds; a second wall is the answer.
        if (verdict === 'pause' && ++walls < 2) continue
        return strip({ ...r, error: 'rate_limited', wall: { by: r.wallBy, skipped: false }, requests })
      }
      const limited = r.status === 429 || (r.status === 503 && !!r.retryAfter)
      if (limited && !o.signal.aborted) {
        o.onRateLimited?.(new URL(r.finalUrl).host)
        if (++rateLimited < o.rateLimitAttempts) {
          await o.clock.sleep(retryAfterMs(r.retryAfter ?? null, o.clock.now()), o.signal)
          continue
        }
        return strip({ ...r, error: 'rate_limited', requests })
      }
      const transient = (r.status !== null && isTransientStatus(r.status)) || r.transientError === true
      if (transient && !retriedTransient && !o.signal.aborted) {
        retriedTransient = true
        await o.clock.sleep(o.retryDelayMs, o.signal)
        continue
      }
      return strip({ ...r, requests })
    }
  }

  const strip = ({ retryAfter: _r, transientError: _t, location: _l, wireMs: _w, wallBy: _b, wallHost: _h, ...rest }: Attempt): Outcome => rest

  /** GET a page, following redirects hop by hop; stops early when `stopAt(next)` says the target is already known. */
  async function pageAttempt(url: string, referer: string | undefined, stopAt: (next: string) => boolean): Promise<Attempt> {
    const chain: RedirectHop[] = []
    let current = url
    let requests = 0
    const started = o.clock.now()
    for (;;) {
      const r = await once(current, { method: 'GET', referer, read: (ct) => HTML.test(ct), maxBytes: o.maxBodyBytes, manual: true })
      requests += r.requests
      if (!isRedirect(r.status) || !r.location) return { ...r, url, chain, requests, timing: { ttfb: r.timing.ttfb, total: o.clock.now() - started } }
      chain.push({ url: current, status: r.status!, ms: Math.round(r.wireMs ?? 0) })
      let next: string
      try {
        next = new URL(r.location, current).toString()
      } catch {
        return { ...r, url, chain, requests, error: 'invalid_url' }
      }
      if (stopAt(next)) return { ...r, url, finalUrl: next, chain, requests, timing: { ttfb: r.timing.ttfb, total: o.clock.now() - started } }
      if (chain.length > maxRedirects) return { ...r, url, finalUrl: next, chain, requests, status: null, error: 'connection_error' }
      current = next
    }
  }

  return {
    /** A page: GET, reading the body when it is HTML, following redirects unless they reach a page `stopAt` knows. */
    page: (url: string, referer?: string, stopAt: (next: string) => boolean = () => false) => withRetries(() => pageAttempt(url, referer, stopAt)),
    /**
     * A plain-text resource (robots.txt, sitemaps): GET and read whatever it is, up to `maxBytes`, error
     * pages included: a hosting service says "nothing is set up here" with a 404 (takeover watch). Callers
     * look at the status before trusting the body.
     */
    text: (url: string, maxBytes = o.maxBodyBytes) => withRetries(() => once(url, { method: 'GET', read: () => true, maxBytes, manual: false, readErrors: true })),
    /** The same URL asked for as another client (a phone's or a desktop's browser): GET, redirects followed, body not read. */
    as: (url: string, userAgent: string) => withRetries(() => once(url, { method: 'GET', read: () => false, maxBytes: 0, manual: false, userAgent })),
    /** A link target that will not be crawled: HEAD, then GET for statuses servers often get wrong on HEAD. */
    link: (url: string, referer?: string) =>
      withRetries(async () => {
        const head = await once(url, { method: 'HEAD', referer, read: () => false, maxBytes: 0, manual: false })
        if (!headFailed(head) || head.wallBy || head.wall) return head
        const get = await once(url, { method: 'GET', referer, read: () => false, maxBytes: 0, manual: false })
        return { ...get, requests: get.requests + head.requests }
      }),
  }
}

export type Requester = ReturnType<typeof createRequester>
