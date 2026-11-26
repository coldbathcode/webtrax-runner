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
 * - **Targeted** (C06.8, `target.urls`): only the start page's answer and the
 *   URLs named are fetched as pages; their links are checked, never crawled,
 *   and sitemaps are not read. `rules` narrows what is reported. A suite
 *   whose config says `start_only` sees the start page only.
 */
import { createGuardedFetch, type GuardedFetch } from '@webtrax/net-guard'
import {
  BOT_USER_AGENT, fingerprint, JobSpec, normaliseUrl, PROTOCOL_VERSION, RuleMeta, ruleSelected, severityRank, type BrowserProfileId, type FetchError, type FindingRecord, type JobSpecInput, type PageRecord,
  type RedirectHop, type RunLine, type Severity, type StopReason, type SummaryRecord,
} from '@webtrax/protocol'
import { isBrokenOutcome } from './classify'
import { isHtml, parseHtml, type ParsedDoc } from './html'
import { linkRecords } from './links'
import { rdapRegistration, systemDns, type Lookups } from './lookups'
import { createRequester, type Outcome, type Requester } from './requester'
import { ALLOW_ALL, parseRobots, type Robots } from './robots'
import { parseSitemap } from './sitemap'
import { MemorySink, type Sink } from './sink'
import type { BrowserPage, CheckSuite, FindingInput, SuiteCtx } from './suite'
import { readRenderedLinks, type RenderedLinks } from './rendered-links'
import { recordTrace, type PageTrace } from './trace'
import { startEgressProxy, type Refusal } from '@webtrax/net-proxy'
import { launchBrowser } from './browser'
import { deviceUserAgent, PROFILES, phoneUserAgent } from './profiles'
import { HostThrottle, realClock, sharedThrottle, type ThrottleClock } from './throttle'

export interface EngineOptions {
  requestTimeoutMs: number
  retryDelayMs: number
  maxHtmlBytes: number
  maxRobotsBytes: number
  maxSitemapBytes: number
  maxSitemaps: number
  /**
   * Sitemap entries kept, as a multiple of the page limit (at least 5,000).
   * A crawl can only use as many as it may fetch; a site with a million
   * entries used to hold them all in memory, as entries and again as edges.
   */
  sitemapEntriesPerPage: number
  rateLimitAttempts: number
  /** Link checks in flight at once (V2-COR-05): unbounded, a page of thousands of links starts them all and they time each other out. */
  linkCheckConcurrency: number
  /** Distinct link targets checked per run; further ones are counted in `site.linksNotChecked`, never reported as anything. */
  maxLinkChecks: number
  /** URLs longer than this are not crawled, checked or recorded (the protocol's limit is 4,096). */
  maxUrlLength: number
  /** After the time budget runs out, in-flight work gets this long to finish. */
  drainMs: number
  /** Record what the browser asked for on each page it loads (`site.traces`). */
  traces: boolean
  /** Overrides the spec's time budget (tests; the spec's minimum is 10 s). */
  timeBudgetMs?: number
  /** Write a `link` record per link target before the summary (C06.9). */
  linkRecords: boolean
  /** Read each loaded page's links as a visitor sees them, opening menus, after the suites (`site.rendered`, C06.10 slice c). */
  renderedLinks: boolean
}

export const ENGINE_DEFAULTS: EngineOptions = {
  requestTimeoutMs: 15_000,
  retryDelayMs: 750,
  maxHtmlBytes: 5 * 1024 * 1024,
  maxRobotsBytes: 512 * 1024,
  maxSitemapBytes: 10 * 1024 * 1024,
  maxSitemaps: 50,
  sitemapEntriesPerPage: 5,
  traces: true,
  rateLimitAttempts: 3,
  linkCheckConcurrency: 8,
  maxLinkChecks: 5_000,
  maxUrlLength: 2_000,
  drainMs: 15_000,
  linkRecords: true,
  renderedLinks: true,
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
  /** Set when the browser stage ran: pages loaded, and requests the egress proxy refused. */
  browser?: { pages: number; refused: Refusal[]; profiles?: BrowserProfileId[] }
  /** What the browser asked for on each page it loaded, per profile (C20 E5; `traces: false` turns it off). */
  traces?: PageTrace[]
  /** Why the crawl did not see the whole site (a stop or a limit), set before the suites' onSite; absent when it did. */
  incomplete?: StopReason
  /** Links as a visitor sees them on each page the browser loaded, per profile (C06.10 slice c; `renderedLinks: false` turns it off). */
  rendered?: RenderedLinks[]
  /** The sitemaps list more pages than the run keeps (`sitemapEntriesPerPage`): the rest were not read. */
  sitemapTruncated?: boolean
  /** Link targets left unchecked because the run reached `maxLinkChecks`. */
  linksNotChecked?: number
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
  /**
   * Called as each URL of the crawl is answered, with the page that led to it
   * (null for the start page and for pages found only in a sitemap). For a
   * caller that shows the crawl while it runs. Errors here are ignored.
   */
  onFetched?: (fetched: { url: string; status: number | null; depth: number; total_ms: number | null; from: string | null }) => void
  /**
   * Called with the start page loaded in Chromium (after the suites have seen
   * it), for a caller that wants to look at the rendered page itself, such as
   * taking a thumbnail. Setting it makes the browser stage run even when no
   * browser suite does. An error here is recorded and never fails the run.
   */
  onHomePage?: (page: BrowserPage) => void | Promise<void>
  /**
   * Runs the browser stage when the caller says there is room. A process
   * that runs several crawls at once passes a limiter here, so only a few
   * Chromium instances are open at a time (each takes a CPU and several
   * hundred megabytes; crawls are cheap). Default: run at once.
   */
  browserGate?: <T>(stage: () => Promise<T>) => Promise<T>
  /** Check suites available to this run; the spec's `suites` decides which run. */
  suites?: CheckSuite[]
  /** DNS and domain registration for site-level rules; defaults to the system resolver and RDAP through the run's fetch (C06.9 slice e). */
  lookups?: Partial<Lookups>
  runner?: { name: string; version: string }
  options?: Partial<EngineOptions>
}

export interface SuiteError { suite: string; hook: 'onPage' | 'onSite' | 'onBrowserPage' | 'onHomePage' | 'browser' | 'record'; url?: string; message: string }

/**
 * What a run actually looked at, for anyone deciding that an earlier finding
 * is gone (V2-COR-01, V2-COR-02): a finding that this run did not report is
 * only fixed if the run checked its URL with that suite.
 */
export interface Reached {
  /** Every URL fetched: crawled pages, checked link targets and files the suites asked for. */
  all: string[]
  /** For each suite that ran in the browser stage: the pages it loaded. */
  bySuite: Record<string, string[]>
}
export interface CrawlResult { summary: SummaryRecord; site: SiteState | null; findings: FindingRecord[]; suiteErrors: SuiteError[]; reached: Reached }

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

/**
 * The job's `auth.headers` (a protected preview's bypass header, say), for the
 * start URL's origin only. Values must be plain strings here: a secret
 * reference is resolved by whoever builds the spec.
 */
/** The spec as the run record keeps it: auth values never reach run.ndjson or a report. */
export function redactAuth(spec: JobSpec): JobSpec {
  if (!spec.auth) return spec
  const hide = <T>(o: Record<string, T> | undefined) => (o ? Object.fromEntries(Object.keys(o).map((k) => [k, '[redacted]'])) : undefined)
  const auth = {
    ...(spec.auth.headers ? { headers: hide(spec.auth.headers)! } : {}),
    ...(spec.auth.basic ? { basic: { username: spec.auth.basic.username, password: '[redacted]' } } : {}),
    ...(spec.auth.cookies ? { cookies: spec.auth.cookies.map((c) => ({ ...c, value: '[redacted]' })) } : {}),
  }
  return { ...spec, auth }
}

export function authHeaders(spec: JobSpec): { origin: string; headers: Record<string, string> } | undefined {
  const given = spec.auth?.headers
  if (!given || !Object.keys(given).length) return undefined
  const headers: Record<string, string> = {}
  for (const [name, value] of Object.entries(given)) {
    if (typeof value !== 'string') throw new Error(`auth header ${name}: secret references must be resolved before the crawl`)
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name) || /[\r\n\0]/.test(value)) throw new Error(`auth header ${name}: invalid name or value`)
    headers[name.toLowerCase()] = value
  }
  return { origin: new URL(spec.target.start_url).origin, headers }
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

  const originHeaders = authHeaders(spec)
  const throttle = deps.throttle ?? sharedThrottle
  // The site itself may find its own pace (limits.origin_max_rps); every other host keeps per_host_rps.
  // It is set again for the origin the start URL settles on (a redirect to www. is the same site).
  let originHost = new URL(spec.target.start_url).host
  const originMax = spec.limits.origin_max_rps
  const paceOrigin = (host: string) => { if (originMax) throttle.adaptive(host, spec.limits.per_host_rps, originMax) }
  paceOrigin(originHost)
  // Firewalls and bot walls met in this run, per host: reported, never got around.
  const walls = new Map<string, { by: string | null; walls: number; skipped: number }>()
  const wallOf = (host: string) => walls.get(host) ?? (walls.set(host, { by: null, walls: 0, skipped: 0 }), walls.get(host)!)
  const requester: Requester = createRequester({
    fetch, throttle, clock, userAgent, rps: spec.limits.per_host_rps, signal: internal.signal,
    timeoutMs: opts.requestTimeoutMs, retryDelayMs: opts.retryDelayMs, maxBodyBytes: opts.maxHtmlBytes, rateLimitAttempts: opts.rateLimitAttempts,
    onRateLimited: (host) => throttle.penalise(host),
    onWalled: (host, by) => {
      const w = wallOf(host)
      w.by ??= by
      w.walls += 1
      const verdict = throttle.wall(host)
      // The site's own protection keeps refusing: what is left of the crawl would only be refused too.
      if (verdict === 'stop' && host === originHost) stop('blocked')
      return verdict
    },
    onWallSkip: (host) => { wallOf(host).skipped += 1 },
    ...(originHeaders ? { originHeaders } : {}),
  })

  // A record the protocol refuses (a 5,000-character URL, a status of 600) must cost that record, not
  // the run: it is noted as an error and the crawl goes on (V2-COR-06). The run and summary records
  // are the engine's own and are never dropped.
  const recordErrors: SuiteError[] = []
  const write = async (record: RunLine) => {
    if (record.type === 'run' || record.type === 'summary') return sink.write(record)
    try {
      await sink.write(record)
    } catch (error) {
      const suite = record.type === 'finding' ? record.suite : 'engine'
      if (recordErrors.length < 50) recordErrors.push({ suite, hook: 'record', ...('url' in record && typeof record.url === 'string' ? { url: record.url.slice(0, 200) } : {}), message: `a ${record.type} record was not valid and was left out: ${(error as Error).message.slice(0, 200)}` })
    }
  }
  await write({ type: 'run', protocol_version: PROTOCOL_VERSION, job_id: spec.job_id, started_at: startedAt, runner: deps.runner ?? { name: '@webtrax/engine', version: '0.0.0' }, user_agent: userAgent, spec: redactAuth(spec) })

  // Suites: those the spec enables, with their rules validated up front.
  const findings: FindingRecord[] = []
  const findingSeverity = new Map<string, Severity>()
  const emitted = new Set<string>()
  // What the run looked at (CrawlResult.reached), and the suites whose silence proves nothing.
  const reachedUrls = new Set<string>()
  const browserUrls = new Map<CheckSuite, Set<string>>()
  const skippedSuites = new Set<string>()
  const incomplete = () => new Set<string>([...skippedSuites, ...suiteErrors.map((e) => e.suite), ...recordErrors.map((e) => e.suite)])
  // Pages each suite looked at in the browser stage, per profile (the summary's `suites[].pages`).
  const browserPages = new Map<CheckSuite, Partial<Record<BrowserProfileId, number>>>()
  // Set by the browser stage while it runs more than one profile.
  let currentProfile: BrowserProfileId | null = null
  let profileFindings: Map<string, { record: FindingRecord; severities: Partial<Record<BrowserProfileId, Severity>> }> | null = null
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
    // A targeted check asked about some rules only: the others are not reported (and so not resolved by this run).
    if (!ruleSelected(rule.meta.id, spec.rules)) return
    const url = input.url === null ? null : (normaliseUrl(input.url) ?? input.url)
    const fp = await fingerprint(rule.meta.id, url, input.evidence_key ?? '')
    const key = `${fp} ${input.source_url ?? ''}`
    const record: FindingRecord = {
      type: 'finding', fingerprint: fp, suite: suite.id, rule_id: rule.meta.id, rule_version: rule.meta.version, severity: input.severity ?? rule.meta.severity,
      url, ...(input.source_url ? { source_url: input.source_url } : {}), title: input.title ?? rule.meta.title, evidence: input.evidence ?? {},
    }
    // With several browser profiles, one finding lists the profiles it was seen in (the profile is
    // not part of its identity) and keeps the worst of them; it is written when the stage ends.
    if (profileFindings && currentProfile) {
      const seen = profileFindings.get(key)
      if (!seen) profileFindings.set(key, { record, severities: { [currentProfile]: record.severity } })
      else {
        const before = seen.severities[currentProfile]
        if (!before || severityRank(record.severity) < severityRank(before)) seen.severities[currentProfile] = record.severity
        if (severityRank(record.severity) < severityRank(seen.record.severity)) seen.record = record
      }
      return
    }
    if (emitted.has(key)) return
    emitted.add(key)
    findings.push(record)
    findingSeverity.set(fp, record.severity)
    await write(record)
  }

  const finish = async (summary: Omit<SummaryRecord, 'type' | 'job_id' | 'started_at' | 'finished_at' | 'findings' | 'suites'>, site: SiteState | null): Promise<CrawlResult> => {
    clearTimeout(budgetTimer)
    clearTimeout(drainTimer)
    deps.signal?.removeEventListener('abort', onCancel)
    // The link graph, one record per target (C06.9): before the summary, so a record the protocol refuses is counted in it.
    if (site && opts.linkRecords) for (const r of linkRecords(site)) await write(r)
    const record: SummaryRecord = {
      type: 'summary', job_id: spec.job_id, started_at: startedAt, finished_at: new Date(clock.now()).toISOString(),
      findings: { critical: 0, high: 0, medium: 0, low: 0, info: 0 },
      suites: active.map((x) => ({
        id: x.id, version: x.version, requires: x.requires,
        ...(incomplete().has(x.id) ? { complete: false } : {}),
        ...(skippedSuites.has(x.id) ? { skipped: true } : {}),
        ...(browserPages.has(x) ? { pages: browserPages.get(x)! } : {}),
      })), ...summary,
      ...(walls.size ? { walls: [...walls].slice(0, 50).map(([host, w]) => ({ host, by: w.by, origin: host === originHost, walls: w.walls, skipped: w.skipped })) } : {}),
      ...(originMax ? { origin_rps: Math.round((throttle.peakRate(originHost) ?? spec.limits.per_host_rps) * 10) / 10 } : {}),
    }
    for (const severity of findingSeverity.values()) record.findings[severity] += 1
    await write(record)
    await ownFetch?.close()
    suiteErrors.push(...recordErrors)
    return { summary: record, site, findings, suiteErrors, reached: { all: [...reachedUrls], bySuite: Object.fromEntries([...browserUrls].map(([suite, urls]) => [suite.id, [...urls]])) } }
  }

  // 1. The start URL: reachable, and on this site.
  // Follow same-site redirects (http→https, apex↔www); stop, without fetching it, at the first hop to another site.
  const offsite = (next: string) => new URL(next).origin !== new URL(spec.target.start_url).origin && !isSameSite(spec.target.start_url, next)
  const start = await requester.page(spec.target.start_url, undefined, offsite)
  if (!start.error && offsite(start.finalUrl)) {
    return finish({ status: 'failed', error: 'start_url_redirects_offsite', pages: { crawled: 0, failed: 0 }, links: { checked: 0, broken: 0 } }, null)
  }
  if (start.error || start.status === null || start.status >= 400) {
    return finish({
      status: 'failed', error: 'start_url_unreachable', start: { status: start.status, ...(start.error ? { error: start.error } : {}) },
      pages: { crawled: 0, failed: 1 }, links: { checked: 0, broken: 0 },
    }, null)
  }
  const origin = new URL(start.finalUrl).origin
  if (new URL(origin).host !== originHost) {
    originHost = new URL(origin).host
    paceOrigin(originHost)
  }
  const startUrl = normaliseUrl(start.finalUrl) ?? start.finalUrl
  const isInternal = (url: string) => new URL(url).origin === origin

  // 2. robots.txt and sitemaps.
  let robots: Robots = ALLOW_ALL
  if (spec.scope.respect_robots) {
    const robotsUrl = `${origin}/robots.txt`
    const r = await requester.text(robotsUrl, opts.maxRobotsBytes)
    robots = parseRobots(robotsUrl, r.status !== null && r.status < 400 ? (r.body ?? '') : '', userAgent)
    const delay = robots.crawlDelay()
    if (delay) throttle.setCrawlDelay(new URL(origin).host, delay)
  }

  const sitemapUrls: string[] = []
  const sitemapLocs: { loc: string; sitemap: string }[] = []
  // A targeted check fetches only what it was asked about: no sitemaps.
  const targeted = (spec.target.urls?.length ?? 0) > 0
  const sitemapQueue = targeted ? [] : [...new Set([`${origin}/sitemap.xml`, ...robots.sitemaps()])].filter((u) => {
    try { return isInternal(u) } catch { return false }
  })
  const maxSitemapEntries = Math.max(5_000, spec.limits.max_pages * opts.sitemapEntriesPerPage)
  let sitemapTruncated = false
  while (sitemapQueue.length && sitemapUrls.length < opts.maxSitemaps && !stopReason && !sitemapTruncated) {
    const url = sitemapQueue.shift()!
    if (sitemapUrls.includes(url)) continue
    sitemapUrls.push(url)
    const r = await requester.text(url, opts.maxSitemapBytes)
    if (r.status === null || r.status >= 400 || !r.body) continue
    const parsed = parseSitemap(r.body)
    for (const loc of parsed.locs) {
      if (parsed.isIndex) { if (loc.startsWith(origin)) sitemapQueue.push(loc) }
      else if (sitemapLocs.length < maxSitemapEntries) sitemapLocs.push({ loc, sitemap: url })
      else { sitemapTruncated = true; break }
    }
  }

  // 3. The crawl.
  const site: SiteState = { origin, startUrl, requestedStartUrl: spec.target.start_url, robots, pages: new Map(), links: new Map(), edges: [], sitemapUrls, ...(sitemapTruncated ? { sitemapTruncated } : {}) }
  // Passive lookups, each answered once per run whichever suite asks.
  const lookups: Lookups = {
    dns: deps.lookups?.dns ?? systemDns,
    registration: deps.lookups?.registration ?? rdapRegistration((url) => requester.text(url, 512 * 1024)),
  }
  const looked = new Map<string, Promise<unknown>>()
  const once = <T>(key: string, f: () => Promise<T>): Promise<T> => {
    if (!looked.has(key)) looked.set(key, f())
    return looked.get(key) as Promise<T>
  }
  const ctxFor = (suite: CheckSuite): SuiteCtx => ({
    dns: (host) => once(`dns ${host.toLowerCase()}`, () => lookups.dns(host.toLowerCase()).catch(() => ({ status: 'error' as const, cname: [], addresses: [] }))),
    registration: (domain) => once(`rdap ${domain.toLowerCase()}`, () => lookups.registration(domain.toLowerCase()).catch(() => 'unknown' as const)),
    spec, config: spec.suites[suite.id]?.config ?? {}, origin, startUrl, requestedStartUrl: spec.target.start_url, emit: emitFor(suite),
    request: (url) => { reachedUrls.add(normaliseUrl(url) ?? url); return requester.page(url, undefined, () => true) },
    text: (url, maxBytes = 256 * 1024) => { reachedUrls.add(normaliseUrl(url) ?? url); return requester.text(url, maxBytes) },
    requestAs: (url, device) => requester.as(url, deviceUserAgent(device)),
    metric: async (name, value, unit, url) => {
      const profile = currentProfile ?? spec.browser.profiles[0]!
      await write({ type: 'metric', name, value, unit, url: normaliseUrl(url) ?? url, device: PROFILES[profile].form === 'phone' ? 'mobile' : 'desktop', profile })
    },
  })
  const contexts = new Map(active.map((suite) => [suite, ctxFor(suite)]))
  const runHook = async (suite: CheckSuite, hook: 'onPage' | 'onSite' | 'onBrowserPage', call: () => void | Promise<void>, url?: string) => {
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

  // Set when a page that belongs to the crawl was left out by a limit: the run is then partial, not complete (V2-COR-02).
  let limitHit: StopReason | undefined
  const crawlable = (url: string, depth: number) => {
    if (!isInternal(url) || !included(url) || excluded(url) || url.length > opts.maxUrlLength) return false
    if (depth > spec.limits.max_depth) { limitHit ??= 'depth_limit'; return false }
    if (queued.size >= spec.limits.max_pages) { limitHit = 'page_limit'; return false }
    return true
  }

  const enqueue = (item: QueueItem) => {
    queued.add(item.url)
    frontier.push(item)
  }

  const recordLink = (url: string, internalLink: boolean, via: LinkOutcome['via'], o: Pick<Outcome, 'status' | 'error' | 'finalUrl' | 'chain'>) => {
    // A URL that a rate limit or a wall answered was not checked: nothing about it may be called fixed (V2-COR-01).
    if (via !== 'skipped' && o.error !== 'rate_limited') reachedUrls.add(url)
    site.links.set(url, { url, internal: internalLink, via, status: o.status, ...(o.error ? { error: o.error } : {}), finalUrl: o.finalUrl, chain: o.chain })
  }

  /** A link target the crawl will not fetch: check it once (or skip it, for robots). */
  // At most `linkCheckConcurrency` link checks run at once; the rest wait their turn (V2-COR-05).
  let checking = 0
  const waitingChecks: (() => void)[] = []
  const linkSlot = async () => {
    if (checking >= opts.linkCheckConcurrency) await new Promise<void>((resolve) => waitingChecks.push(resolve))
    else checking += 1
  }
  const freeLinkSlot = () => {
    const next = waitingChecks.shift()
    if (next) next()
    else checking -= 1
  }
  const checkLink = (url: string, referer: string) => {
    if (linkChecks.has(url) || queued.has(url) || site.links.has(url)) return
    if (url.length > opts.maxUrlLength) return
    const internalLink = isInternal(url)
    if (internalLink && !robots.isAllowed(url)) {
      recordLink(url, true, 'skipped', { status: null, error: 'robots_disallowed', finalUrl: url, chain: [] })
      return
    }
    if (!internalLink && !spec.scope.check_external) return
    if (linkChecks.size >= opts.maxLinkChecks) {
      site.linksNotChecked = (site.linksNotChecked ?? 0) + 1
      return
    }
    linkChecks.set(url, (async () => {
      await linkSlot()
      try {
        if (stopReason) return
        const o = await requester.link(url, referer)
        if (!internal.signal.aborted) recordLink(url, internalLink, 'check', o)
      } finally {
        freeLinkSlot()
      }
    })())
  }

  const discover = (url: string, depth: number, referer: string) => {
    if (queued.has(url) || site.links.has(url)) return
    if (!targeted && isInternal(url) && robots.isAllowed(url) && crawlable(url, depth)) enqueue({ url, depth, referer })
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
    try { deps.onFetched?.({ url: item.url, status: outcome.status, depth: item.depth, total_ms: outcome.timing ? Math.round(outcome.timing.total) : null, from: item.referer && site.pages.has(item.referer) ? item.referer : null }) } catch { /* a watcher never stops a crawl */ }
    // A page cut off at the size limit was not read to its end: links and text after the cut were not seen.
    if (outcome.truncated) limitHit ??= 'page_truncated'

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
      if (doc.templateKey) record.template_key = doc.templateKey
    }
    site.pages.set(item.url, record)
    await write(record)
    if (outcome.error || (outcome.status !== null && outcome.status >= 400)) pagesFailed += 1
    if (!doc) return

    pagesCrawled += 1
    const crawled: CrawledPage = { url: finalUrl, depth: item.depth, outcome, doc }
    await deps.onPage?.(crawled)
    for (const suite of active) {
      if (!suite.onPage || (spec.suites[suite.id]?.config.start_only === true && item.url !== startUrl)) continue
      await runHook(suite, 'onPage', () => suite.onPage!(contexts.get(suite)!, crawled), finalUrl)
    }
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

  // Seeds: the start page (already fetched), then sitemap entries; for a targeted check, the URLs named instead.
  const named = targeted ? [...new Set(spec.target.urls!.map((u) => normaliseUrl(u)).filter((u): u is string => !!u && u.length <= opts.maxUrlLength))] : []
  if (!targeted || named.includes(startUrl)) enqueue({ url: startUrl, depth: 0, prefetched: start })
  else {
    // Not asked about, but fetched: links to it are answered by that fetch.
    queued.add(startUrl)
    recordLink(startUrl, true, 'crawl', start)
  }
  if (startUrl !== normaliseUrl(spec.target.start_url)) queued.add(normaliseUrl(spec.target.start_url) ?? spec.target.start_url)
  for (const url of named) {
    if (queued.has(url)) continue
    // Another site's URL, or one robots.txt keeps the crawler out of, is checked as a link: never fetched as a page.
    if (isInternal(url) && (robots.isAllowed(url) || !spec.scope.respect_robots)) enqueue({ url, depth: 0 })
    else checkLink(url, startUrl)
  }
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

  // Browser stage (C05.10): one Chromium load per selected page, through the egress proxy.
  // A suite that only defines onBrowserPage joins the stage when a suite that requires the browser caused it.
  // onHomePage alone also starts the stage, but then for the start page only: optional hooks stay out.
  const needBrowser = active.some((s) => s.requires.includes('browser') && s.onBrowserPage)
  const browserSuites = needBrowser ? active.filter((s) => s.onBrowserPage) : []
  // The wait for room counts against the time budget: a run that is out of time by then skips the stage.
  if ((needBrowser || deps.onHomePage) && !stopReason) await (deps.browserGate ?? ((stage) => stage()))(async () => { if (!stopReason) await browserStage(browserSuites) })
  // A suite that needs the browser and never got a page said nothing about anything: it is skipped, not clean (V2-COR-01).
  for (const s of active) if (s.requires.includes('browser') && s.onBrowserPage && !browserPages.has(s)) skippedSuites.add(s.id)

  // Site-level rules may need to know the crawl did not see everything.
  if (stopReason ?? limitHit) site.incomplete = (stopReason ?? limitHit)!
  for (const suite of active) if (suite.onSite) await runHook(suite, 'onSite', () => suite.onSite!(contexts.get(suite)!, site))

  async function browserStage(suites: CheckSuite[]) {
    const pages = [...site.pages.values()]
      .filter((p) => p.status === 200 && p.title !== undefined && isInternal(p.final_url))
      .sort((a, b) => a.depth - b.depth || (a.final_url < b.final_url ? -1 : 1))
      .map((p) => normaliseUrl(p.final_url) ?? p.final_url)
    const wanted = new Map<string, CheckSuite[]>()
    for (const suite of suites) {
      const config = spec.suites[suite.id]?.config ?? {}
      const sample = typeof config.sample === 'number' ? config.sample : (suite.defaultSample ?? 10)
      const urls = suite.selectPages ? suite.selectPages(site, config) : [...new Set(pages)].slice(0, sample)
      for (const url of urls) wanted.set(url, [...(wanted.get(url) ?? []), suite])
    }
    // The start page, for onHomePage: first, and loaded even if no suite picked it.
    const home = normaliseUrl(site.startUrl) ?? site.startUrl
    if (deps.onHomePage && pages.includes(home)) {
      const forHome = wanted.get(home) ?? []
      wanted.delete(home)
      const rest = [...wanted]
      wanted.clear()
      wanted.set(home, forHome)
      for (const [u, x] of rest) wanted.set(u, x)
    }
    // One load per page per profile (C06.10). Every suite sees the first profile; the others are for
    // suites that measure per device (`everyProfile`), on at most `extra_profile_pages` pages each.
    const profiles = [...new Set(spec.browser.profiles)]
    const several = profiles.length > 1
    let loaded = 0
    const refused: Refusal[] = []
    const traces: PageTrace[] = []
    const rendered: RenderedLinks[] = []
    if (several) profileFindings = new Map()
    try {
      for (const [index, id] of profiles.entries()) {
        if (stopReason) break
        const profile = PROFILES[id]
        const first = index === 0
        let plan = [...wanted].map(([url, forSuites]) => [url, first ? forSuites : forSuites.filter((x) => x.everyProfile)] as const)
        if (!first) plan = plan.filter(([, forSuites]) => forSuites.length > 0).slice(0, spec.browser.extra_profile_pages ?? Infinity)
        if (!plan.length) continue
        const proxy = await startEgressProxy({ policy: { allowPrivate: spec.scope.allow_private }, ...(profile.network ? { shape: profile.network } : {}) })
        let browser: Awaited<ReturnType<typeof launchBrowser>> | undefined
        try {
          browser = await launchBrowser(proxy.url)
        } catch (error) {
          for (const suite of suites) suiteErrors.push({ suite: suite.id, hook: 'browser', message: (error as Error).message })
          await proxy.close()
          return
        }
        currentProfile = id
        try {
          for (const [url, forSuites] of plan) {
            if (stopReason) break
            await throttle.wait(new URL(url).host, spec.limits.per_host_rps, internal.signal)
            const context = await browser.newContext({
              serviceWorkers: 'block', acceptDownloads: false, viewport: profile.viewport, deviceScaleFactor: profile.pixelRatio, hasTouch: profile.touch, isMobile: profile.form === 'phone',
              // A phone gets Chrome for Android's string with the Webtrax token; a user agent the spec sets is sent as it is.
              userAgent: profile.form === 'phone' && !spec.user_agent ? phoneUserAgent(browser.version()) : userAgent,
            })
            try {
              // Auth headers on the target's own requests only, never on third-party ones.
              if (originHeaders) {
                await context.route((u) => u.origin === originHeaders.origin, (route) => route.continue({ headers: { ...route.request().headers(), ...originHeaders.headers } }))
              }
              const page = await context.newPage()
              if (profile.cpuSlowdown) {
                const cdp = await context.newCDPSession(page)
                await cdp.send('Emulation.setCPUThrottlingRate', { rate: profile.cpuSlowdown })
              }
              const trace = opts.traces ? recordTrace(page, url, id) : null
              const started = clock.now()
              const response = await page.goto(url, { waitUntil: 'load', timeout: 30_000 }).catch(() => null)
              const bp: BrowserPage = { url, status: response?.status() ?? null, loadMs: clock.now() - started, page, profile: id }
              loaded += 1
              for (const suite of forSuites) {
                browserUrls.set(suite, (browserUrls.get(suite) ?? new Set()).add(url))
                const counted = browserPages.get(suite) ?? {}
                counted[id] = (counted[id] ?? 0) + 1
                browserPages.set(suite, counted)
                await runHook(suite, 'onBrowserPage', () => suite.onBrowserPage!(contexts.get(suite)!, bp), url)
              }
              if (first && deps.onHomePage && url === home) {
                try {
                  await deps.onHomePage(bp)
                } catch (error) {
                  suiteErrors.push({ suite: 'engine', hook: 'onHomePage', url, message: (error as Error).message })
                }
              }
              // After the suites, so what they waited for is in it. A trace is an extra: it never fails a page.
              if (trace) await trace.finish(bp.status, bp.loadMs).then((t) => traces.push(t), () => {})
              // Last, because it opens menus. Like a trace, it never fails a page.
              if (opts.renderedLinks && bp.status !== null && bp.status < 400) {
                const links = await readRenderedLinks(page, url, id).catch(() => null)
                if (links) rendered.push(links)
              }
            } finally {
              await context.close().catch(() => {})
            }
          }
        } finally {
          currentProfile = null
          await browser.close().catch(() => {})
          refused.push(...proxy.refused)
          await proxy.close()
        }
      }
    } finally {
      site.browser = { pages: loaded, refused, ...(several ? { profiles } : {}) }
      if (traces.length) site.traces = traces
      if (rendered.length) site.rendered = rendered
      // Findings of the stage, each with the profiles it was seen in, in the order they were first found.
      const merged = profileFindings
      profileFindings = null
      if (merged) {
        for (const [key, { record, severities }] of merged) {
          if (emitted.has(key)) continue
          emitted.add(key)
          // Where it was seen, and how severe it was there (Health Score v2 scores each device on its own).
          const out: FindingRecord = { ...record, evidence: { ...record.evidence, profiles: Object.keys(severities), severity_by_profile: severities } }
          findings.push(out)
          findingSeverity.set(out.fingerprint, out.severity)
          await write(out)
        }
      }
    }
  }

  // Counted per distinct link target (a link or a sitemap entry), not per page that links to it.
  const targets = [...new Set(site.edges.map((e) => e.to))].map((url) => site.links.get(url)).filter((o): o is LinkOutcome => !!o)
  return finish(
    {
      status: stopReason ?? limitHit ? 'partial' : 'completed',
      ...(stopReason ?? limitHit ? { stop_reason: (stopReason ?? limitHit)! } : {}),
      pages: { crawled: pagesCrawled, failed: pagesFailed },
      links: { checked: targets.filter((o) => o.via !== 'skipped').length, broken: targets.filter(isBrokenOutcome).length },
    },
    site,
  )
}
