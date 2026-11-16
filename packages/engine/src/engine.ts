/**
 * The crawl engine (C05.3): the v1 crawl loop rebuilt as the single-fetch
 * pipeline in plan/05-runner/pipeline-and-suite-contract.md.
 *
 * - The start URL is fetched once and, if it redirects within the same site
 *   (http→https, apex↔www), its final origin becomes the crawl origin (COR-01).
 *   Unreachable, or redirecting to another site, fails the run (COR-02).
 * - Seeds: the start page, sitemap.xml (and sitemap indexes, and robots.txt
 *   `Sitemap:` lines), restricted to the site's origin.
 * - Frontier: breadth first, then by normalised URL, so runs are repeatable.
 *   Every URL is queued once (COR-03); `max_pages` counts queued URLs.
 * - **One fetch per URL.** An internal link to a page the crawl fetches is
 *   answered by that page's own result. Only links the crawl will not visit
 *   (external, beyond the limits, excluded) get a link check, once each.
 * - robots.txt: disallowed URLs are never requested; Crawl-delay is honoured.
 * - Politeness, timeouts, retries and 429 handling live in the requester and
 *   the shared host throttle.
 * - Time budget and cancellation stop the frontier and end the run `partial`.
 */
import { createGuardedFetch, type GuardedFetch, type RedirectHop } from '@webtrax/net-guard'
import {
  BOT_USER_AGENT, fingerprint, JobSpec, normaliseUrl, PROTOCOL_VERSION, RuleMeta, type FetchError, type FindingRecord, type JobSpecInput, type PageRecord,
  type RunLine, type Severity, type StopReason, type SummaryRecord,
} from '@webtrax/protocol'
import { isBrokenOutcome } from './classify'
import { isHtml, parseHtml, type ParsedDoc } from './html'
import { createRequester, type Outcome, type Requester } from './requester'
import { ALLOW_ALL, parseRobots, type Robots } from './robots'
import { parseSitemap } from './sitemap'
import { MemorySink, type Sink } from './sink'
import type { CheckSuite, FindingInput, SuiteCtx } from './suite'
import { HostThrottle, realClock, sharedThrottle, type ThrottleClock } from './throttle'

export interface EngineOptions {
  requestTimeoutMs: number
  retryDelayMs: number
  maxHtmlBytes: number
  maxRobotsBytes: number
  maxSitemapBytes: number
  maxSitemaps: number
  rateLimitAttempts: number
  /** After the time budget runs out, in-flight work gets this long to finish. */
  drainMs: number
  /** Overrides the spec's time budget (tests; the spec's minimum is 10 s). */
  timeBudgetMs?: number
}

export const ENGINE_DEFAULTS: EngineOptions = {
  requestTimeoutMs: 15_000,
  retryDelayMs: 750,
  maxHtmlBytes: 5 * 1024 * 1024,
  maxRobotsBytes: 512 * 1024,
  maxSitemapBytes: 10 * 1024 * 1024,
  maxSitemaps: 50,
  rateLimitAttempts: 3,
  drainMs: 15_000,
}

/** A fetched HTML page, parsed once, as suites will receive it (C05.4). */
export interface CrawledPage {
  url: string
  depth: number
  outcome: Outcome
  doc: ParsedDoc
}

/** The result of one link target: answered by the crawl, by a link check, or skipped. */
export interface LinkOutcome {
  url: string
  internal: boolean
  via: 'crawl' | 'check' | 'skipped'
  status: number | null
  error?: FetchError
  finalUrl: string
  chain: RedirectHop[]
}

export interface LinkEdge { from: string; to: string; text: string; kind: 'link' | 'sitemap' | 'canonical' }

/** Everything a crawl learned, for site-level suites (C05.4) and reports. */
export interface SiteState {
  origin: string
  startUrl: string
  /** What the spec asked for, before same-site redirects. */
  requestedStartUrl: string
  robots: Robots
  pages: Map<string, PageRecord>
  links: Map<string, LinkOutcome>
  edges: LinkEdge[]
  sitemapUrls: string[]
}

export interface CrawlDeps {
  /** Defaults to a guarded fetch with the spec's scope (`allow_private`). */
  fetch?: GuardedFetch
  sink?: Sink
  throttle?: HostThrottle
  clock?: ThrottleClock
  signal?: AbortSignal
  /** Called once per crawled HTML page with its parsed document. */
  onPage?: (page: CrawledPage) => void | Promise<void>
  /** Check suites available to this run; the spec's `suites` decides which run. */
  suites?: CheckSuite[]
  runner?: { name: string; version: string }
  options?: Partial<EngineOptions>
}

export interface SuiteError { suite: string; hook: 'onPage' | 'onSite'; url?: string; message: string }

export interface CrawlResult { summary: SummaryRecord; site: SiteState | null; findings: FindingRecord[]; suiteErrors: SuiteError[] }

interface QueueItem { url: string; depth: number; referer?: string; prefetched?: Outcome }

/** Depth-bucketed queue: breadth first, then by URL, so the order never depends on timing. */
class Frontier {
  private readonly buckets = new Map<number, string[]>()
  private readonly items = new Map<string, QueueItem>()
  private readonly dirty = new Set<number>()

  push(item: QueueItem): void {
    this.items.set(item.url, item)
    const bucket = this.buckets.get(item.depth) ?? []
    bucket.push(item.url)
    this.buckets.set(item.depth, bucket)
    this.dirty.add(item.depth)
  }

  take(): QueueItem | undefined {
    const depths = [...this.buckets.keys()].sort((a, b) => a - b)
    for (const d of depths) {
      const bucket = this.buckets.get(d)!
      if (this.dirty.delete(d)) bucket.sort((a, b) => (a < b ? 1 : a > b ? -1 : 0)) // pop() takes the smallest
      const url = bucket.pop()
      if (bucket.length === 0) this.buckets.delete(d)
      if (url !== undefined) {
        const item = this.items.get(url)!
        this.items.delete(url)
        return item
      }
    }
    return undefined
  }

  get size(): number {
    return this.items.size
  }
}

/** Same-site redirect for origin adoption: hosts equal once a leading `www.` is ignored (v1 isSameSiteRedirect). */
export function isSameSite(fromUrl: string, toUrl: string): boolean {
  const bare = (u: string) => new URL(u).hostname.toLowerCase().replace(/^www\./, '')
  try {
    return bare(fromUrl) === bare(toUrl)
  } catch {
    return false
  }
}

/** Scope include/exclude: path prefixes, with `*` as a wildcard. */
function pathMatcher(patterns: readonly string[]): (url: string) => boolean {
  const res = patterns.map((p) => new RegExp(`^${p.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}`))
  return (url) => {
    const { pathname, search } = new URL(url)
    return res.some((re) => re.test(pathname + search))
  }
}

export async function crawl(input: JobSpecInput, deps: CrawlDeps = {}): Promise<CrawlResult> {
  const spec = JobSpec.parse(input)
  const opts = { ...ENGINE_DEFAULTS, ...deps.options }
  const clock = deps.clock ?? realClock
  const sink = deps.sink ?? new MemorySink()
  const userAgent = spec.user_agent ?? BOT_USER_AGENT
  const ownFetch = deps.fetch ? null : createGuardedFetch({ policy: { allowPrivate: spec.scope.allow_private } })
  const fetch = deps.fetch ?? ownFetch!
  const startedAt = new Date(clock.now()).toISOString()

  // Cancellation and the time budget both abort through one controller.
  const internal = new AbortController()
  let stopReason: StopReason | undefined
  const stop = (reason: StopReason) => {
    stopReason ??= reason
  }
  const onCancel = () => {
    stop('canceled')
    internal.abort()
  }
  if (deps.signal?.aborted) onCancel()
  deps.signal?.addEventListener('abort', onCancel, { once: true })
  let drainTimer: ReturnType<typeof setTimeout> | undefined
  const budgetTimer = setTimeout(() => {
    stop('time_budget')
    drainTimer = setTimeout(() => internal.abort(), opts.drainMs)
  }, opts.timeBudgetMs ?? spec.limits.time_budget_s * 1000)

  const requester: Requester = createRequester({
    fetch, throttle: deps.throttle ?? sharedThrottle, clock, userAgent, rps: spec.limits.per_host_rps, signal: internal.signal,
    timeoutMs: opts.requestTimeoutMs, retryDelayMs: opts.retryDelayMs, maxBodyBytes: opts.maxHtmlBytes, rateLimitAttempts: opts.rateLimitAttempts,
    onRateLimited: (host) => (deps.throttle ?? sharedThrottle).penalise(host),
  })

  const write = async (record: RunLine) => sink.write(record)
  await write({ type: 'run', protocol_version: PROTOCOL_VERSION, job_id: spec.job_id, started_at: startedAt, runner: deps.runner ?? { name: '@webtrax/engine', version: '0.0.0' }, user_agent: userAgent, spec })

  // Suites: those the spec enables, with their rules validated up front.
  const findings: FindingRecord[] = []
  const findingSeverity = new Map<string, Severity>()
  const emitted = new Set<string>()
  const suiteErrors: SuiteError[] = []
  const active = (deps.suites ?? []).filter((suite) => spec.suites[suite.id]?.enabled)
  const rules = new Map<string, { suite: CheckSuite; meta: RuleMeta }>()
  for (const suite of active) {
    for (const raw of suite.rules) {
      const meta = RuleMeta.parse(raw)
      if (meta.suite !== suite.id || !meta.id.startsWith(`${suite.id}.`)) throw new Error(`rule ${meta.id} does not belong to suite ${suite.id}`)
      if (rules.has(meta.id)) throw new Error(`rule ${meta.id} is declared twice`)
      rules.set(meta.id, { suite, meta })
    }
  }

  const emitFor = (suite: CheckSuite) => async (input: FindingInput) => {
    const rule = rules.get(input.rule_id)
    if (!rule || rule.suite !== suite) throw new Error(`suite ${suite.id} emitted undeclared rule ${input.rule_id}`)
    const url = input.url === null ? null : (normaliseUrl(input.url) ?? input.url)
    const fp = await fingerprint(rule.meta.id, url, input.evidence_key ?? '')
    const key = `${fp} ${input.source_url ?? ''}`
    if (emitted.has(key)) return
    emitted.add(key)
    const record: FindingRecord = {
      type: 'finding', fingerprint: fp, suite: suite.id, rule_id: rule.meta.id, rule_version: rule.meta.version, severity: input.severity ?? rule.meta.severity,
      url, ...(input.source_url ? { source_url: input.source_url } : {}), title: input.title ?? rule.meta.title, evidence: input.evidence ?? {},
    }
    findings.push(record)
    findingSeverity.set(fp, record.severity)
    await write(record)
  }

  const finish = async (summary: Omit<SummaryRecord, 'type' | 'job_id' | 'started_at' | 'finished_at' | 'findings' | 'suites'>, site: SiteState | null): Promise<CrawlResult> => {
    clearTimeout(budgetTimer)
    clearTimeout(drainTimer)
    deps.signal?.removeEventListener('abort', onCancel)
    const record: SummaryRecord = {
      type: 'summary', job_id: spec.job_id, started_at: startedAt, finished_at: new Date(clock.now()).toISOString(),
      findings: { critical: 0, high: 0, medium: 0, low: 0, info: 0 }, suites: active.map((x) => ({ id: x.id, version: x.version, requires: x.requires })), ...summary,
    }
    for (const severity of findingSeverity.values()) record.findings[severity] += 1
    await write(record)
    await ownFetch?.close()
    return { summary: record, site, findings, suiteErrors }
  }

  // 1. The start URL: reachable, and on this site.
  // Follow same-site redirects (http→https, apex↔www); stop, without fetching it, at the first hop to another site.
  const offsite = (next: string) => new URL(next).origin !== new URL(spec.target.start_url).origin && !isSameSite(spec.target.start_url, next)
  const start = await requester.page(spec.target.start_url, undefined, offsite)
  if (!start.error && offsite(start.finalUrl)) {
    return finish({ status: 'failed', error: 'start_url_redirects_offsite', pages: { crawled: 0, failed: 0 }, links: { checked: 0, broken: 0 } }, null)
  }
  if (start.error || start.status === null || start.status >= 400) {
    return finish({ status: 'failed', error: 'start_url_unreachable', pages: { crawled: 0, failed: 1 }, links: { checked: 0, broken: 0 } }, null)
  }
  const origin = new URL(start.finalUrl).origin
  const startUrl = normaliseUrl(start.finalUrl) ?? start.finalUrl
  const isInternal = (url: string) => new URL(url).origin === origin

  // 2. robots.txt and sitemaps.
  let robots: Robots = ALLOW_ALL
  if (spec.scope.respect_robots) {
    const robotsUrl = `${origin}/robots.txt`
    const r = await requester.text(robotsUrl, opts.maxRobotsBytes)
    robots = parseRobots(robotsUrl, r.status !== null && r.status < 400 ? (r.body ?? '') : '', userAgent)
    const delay = robots.crawlDelay()
    if (delay) (deps.throttle ?? sharedThrottle).setCrawlDelay(new URL(origin).host, delay)
  }

  const sitemapUrls: string[] = []
  const sitemapLocs: { loc: string; sitemap: string }[] = []
  const sitemapQueue = [...new Set([`${origin}/sitemap.xml`, ...robots.sitemaps()])].filter((u) => {
    try { return isInternal(u) } catch { return false }
  })
  while (sitemapQueue.length && sitemapUrls.length < opts.maxSitemaps && !stopReason) {
    const url = sitemapQueue.shift()!
    if (sitemapUrls.includes(url)) continue
    sitemapUrls.push(url)
    const r = await requester.text(url, opts.maxSitemapBytes)
    if (r.status === null || r.status >= 400 || !r.body) continue
    const parsed = parseSitemap(r.body)
    for (const loc of parsed.locs) {
      if (parsed.isIndex) { if (loc.startsWith(origin)) sitemapQueue.push(loc) }
      else sitemapLocs.push({ loc, sitemap: url })
    }
  }

  // 3. The crawl.
  const site: SiteState = { origin, startUrl, requestedStartUrl: spec.target.start_url, robots, pages: new Map(), links: new Map(), edges: [], sitemapUrls }
  const ctxFor = (suite: CheckSuite): SuiteCtx => ({
    spec, config: spec.suites[suite.id]?.config ?? {}, origin, startUrl, requestedStartUrl: spec.target.start_url, emit: emitFor(suite),
    request: (url) => requester.page(url, undefined, () => true),
  })
  const contexts = new Map(active.map((suite) => [suite, ctxFor(suite)]))
  const runHook = async (suite: CheckSuite, hook: 'onPage' | 'onSite', call: () => void | Promise<void>, url?: string) => {
    try {
      await call()
    } catch (error) {
      // A broken suite must not take the crawl down with it.
      suiteErrors.push({ suite: suite.id, hook, ...(url ? { url } : {}), message: error instanceof Error ? error.message : String(error) })
    }
  }
  const included = spec.scope.include.length ? pathMatcher(spec.scope.include) : () => true
  const excluded = spec.scope.exclude.length ? pathMatcher(spec.scope.exclude) : () => false
  const frontier = new Frontier()
  const queued = new Set<string>()
  const linkChecks = new Map<string, Promise<void>>()
  let pagesCrawled = 0
  let pagesFailed = 0

  const crawlable = (url: string, depth: number) =>
    isInternal(url) && depth <= spec.limits.max_depth && included(url) && !excluded(url) && queued.size < spec.limits.max_pages

  const enqueue = (item: QueueItem) => {
    queued.add(item.url)
    frontier.push(item)
  }

  const recordLink = (url: string, internalLink: boolean, via: LinkOutcome['via'], o: Pick<Outcome, 'status' | 'error' | 'finalUrl' | 'chain'>) => {
    site.links.set(url, { url, internal: internalLink, via, status: o.status, ...(o.error ? { error: o.error } : {}), finalUrl: o.finalUrl, chain: o.chain })
  }

  /** A link target the crawl will not fetch: check it once (or skip it, for robots). */
  const checkLink = (url: string, referer: string) => {
    if (linkChecks.has(url) || queued.has(url) || site.links.has(url)) return
    const internalLink = isInternal(url)
    if (internalLink && !robots.isAllowed(url)) {
      recordLink(url, true, 'skipped', { status: null, error: 'robots_disallowed', finalUrl: url, chain: [] })
      return
    }
    if (!internalLink && !spec.scope.check_external) return
    linkChecks.set(url, (async () => {
      if (stopReason) return
      const o = await requester.link(url, referer)
      if (!internal.signal.aborted) recordLink(url, internalLink, 'check', o)
    })())
  }

  const discover = (url: string, depth: number, referer: string) => {
    if (queued.has(url) || site.links.has(url)) return
    if (isInternal(url) && robots.isAllowed(url) && crawlable(url, depth)) enqueue({ url, depth, referer })
    else checkLink(url, referer)
  }

  const processPage = async (item: QueueItem) => {
    // Stop following redirects at a page the crawl already has or will fetch itself.
    const known = (next: string) => {
      const n = normaliseUrl(next)
      return n !== null && n !== item.url && isInternal(n) && (queued.has(n) || site.pages.has(n))
    }
    const outcome = item.prefetched ?? (await requester.page(item.url, item.referer, known))
    if (internal.signal.aborted && !item.prefetched) return
    const record: PageRecord = {
      type: 'page', url: item.url, final_url: outcome.finalUrl, status: outcome.status, redirect_chain: outcome.chain, depth: item.depth,
      timing_ms: outcome.timing, ...(outcome.error ? { error: outcome.error } : {}), ...(outcome.contentType ? { content_type: outcome.contentType } : {}),
    }
    recordLink(item.url, true, 'crawl', outcome)

    // Attribute the page to its final URL; a redirect to a page we already have adds nothing new.
    const finalUrl = normaliseUrl(outcome.finalUrl) ?? outcome.finalUrl
    let parse = outcome.status !== null && outcome.status < 400 && isHtml(outcome.contentType) && !!outcome.body
    if (finalUrl !== item.url) {
      if (!isInternal(finalUrl) || queued.has(finalUrl) || site.pages.has(finalUrl)) parse = false
      else {
        queued.add(finalUrl)
        recordLink(finalUrl, true, 'crawl', { ...outcome, chain: [] })
      }
    }

    let doc: ParsedDoc | null = null
    if (parse) {
      doc = parseHtml(outcome.body!, finalUrl)
      if (doc.title) record.title = doc.title.slice(0, 1000)
    }
    site.pages.set(item.url, record)
    await write(record)
    if (outcome.error || (outcome.status !== null && outcome.status >= 400)) pagesFailed += 1
    if (!doc) return

    pagesCrawled += 1
    const crawled: CrawledPage = { url: finalUrl, depth: item.depth, outcome, doc }
    await deps.onPage?.(crawled)
    for (const suite of active) if (suite.onPage) await runHook(suite, 'onPage', () => suite.onPage!(contexts.get(suite)!, crawled), finalUrl)
    if (doc.canonical) {
      const canonical = normaliseUrl(doc.canonical, doc.baseUrl)
      if (canonical && canonical !== finalUrl) {
        site.edges.push({ from: finalUrl, to: canonical, text: '', kind: 'canonical' })
        if (!stopReason) discover(canonical, item.depth + 1, finalUrl)
      }
    }
    const seen = new Set<string>()
    for (const link of doc.links) {
      const target = normaliseUrl(link.href, doc.baseUrl)
      if (!target) continue
      site.edges.push({ from: finalUrl, to: target, text: link.text, kind: 'link' })
      if (seen.has(target)) continue
      seen.add(target)
      if (!stopReason) discover(target, item.depth + 1, finalUrl)
    }
  }

  // Seeds: the start page (already fetched), then sitemap entries.
  enqueue({ url: startUrl, depth: 0, prefetched: start })
  if (startUrl !== normaliseUrl(spec.target.start_url)) queued.add(normaliseUrl(spec.target.start_url) ?? spec.target.start_url)
  for (const { loc, sitemap } of sitemapLocs) {
    const url = normaliseUrl(loc)
    if (!url || !isInternal(url)) continue
    site.edges.push({ from: sitemap, to: url, text: '', kind: 'sitemap' })
    if (!queued.has(url) && robots.isAllowed(url) && crawlable(url, 0)) enqueue({ url, depth: 0, referer: sitemap })
  }

  // Workers pull from the frontier until it is empty and nothing is in flight.
  let inFlight = 0
  let waiters: (() => void)[] = []
  const idle = () => new Promise<void>((resolve) => waiters.push(resolve))
  const wake = () => {
    const ready = waiters
    waiters = []
    for (const resolve of ready) resolve()
  }
  const worker = async () => {
    for (;;) {
      if (stopReason) return
      const item = frontier.take()
      if (!item) {
        if (inFlight === 0) return wake()
        await idle()
        continue
      }
      inFlight += 1
      try {
        await processPage(item)
      } finally {
        inFlight -= 1
        wake()
      }
    }
  }
  await Promise.all(Array.from({ length: spec.limits.concurrency }, worker))
  await Promise.all(linkChecks.values())

  for (const suite of active) if (suite.onSite) await runHook(suite, 'onSite', () => suite.onSite!(contexts.get(suite)!, site))

  // Counted per distinct link target (a link or a sitemap entry), not per page that links to it.
  const targets = [...new Set(site.edges.map((e) => e.to))].map((url) => site.links.get(url)).filter((o): o is LinkOutcome => !!o)
  return finish(
    {
      status: stopReason ? 'partial' : 'completed',
      ...(stopReason ? { stop_reason: stopReason } : {}),
      pages: { crawled: pagesCrawled, failed: pagesFailed },
      links: { checked: targets.filter((o) => o.via !== 'skipped').length, broken: targets.filter(isBrokenOutcome).length },
    },
    site,
  )
}
