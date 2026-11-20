/**
 * The suite contract (C05.4; plan/05-runner/pipeline-and-suite-contract.md §3).
 *
 * A suite declares its rules up front and reports findings through
 * `ctx.emit` as it sees each crawled page (`onPage`) and once the crawl is
 * done (`onSite`). The engine fills in what must be uniform across suites:
 * the rule's suite, version and default severity from its RuleMeta, the
 * title, and the fingerprint (rule id + normalised URL + the rule's stable
 * evidence key). Suites never fetch on their own: `ctx.request` goes through
 * the engine's guarded, throttled requester.
 *
 * Differences from the doc, on purpose: hooks call `ctx.emit` instead of
 * returning async iterables (simpler to write and to test), and `plan()` /
 * `onBrowserPage` arrive with the browser stage (C05.10).
 */
import type { Page } from 'playwright-core'
import type { Capability, FetchError, JobSpec, RuleMeta, Severity, SuiteId } from '@webtrax/protocol'
import type { CrawledPage, SiteState } from './engine'
import type { Outcome } from './requester'

export interface FindingInput {
  rule_id: string
  /** What the finding is about; null for site-wide findings. */
  url: string | null
  /** The page it was seen on, when that differs from `url`. */
  source_url?: string
  /** Part of the identity: the same rule on the same URL with a different key is a different finding. Never timings or ordering. */
  evidence_key?: string
  /** Defaults to the rule's title. */
  title?: string
  evidence?: Record<string, unknown>
  /** Defaults to the rule's severity. */
  severity?: Severity
}

export interface SuiteCtx {
  readonly spec: JobSpec
  /** The suite's own config from the spec (`suites.<id>.config`). */
  readonly config: Record<string, unknown>
  readonly origin: string
  /** The start URL after same-site redirects; `requestedStartUrl` is what the spec asked for. */
  readonly startUrl: string
  readonly requestedStartUrl: string
  emit(finding: FindingInput): Promise<void>
  /** Records a metric (performance timings, sizes) for a URL. */
  metric(name: string, value: number, unit: string, url: string): Promise<void>
  /** One guarded GET that does not follow redirects (for checks such as HTTP → HTTPS). */
  request(url: string): Promise<Outcome>
  /** One guarded GET that follows redirects and reads the body whatever its type (robots.txt, llms.txt), at most `maxBytes` (default 256 KB). */
  text(url: string, maxBytes?: number): Promise<Outcome>
}

/** A page loaded once in Chromium (through the egress proxy), shared by every browser suite. */
export interface BrowserPage {
  url: string
  /** HTTP status of the navigation, or null if it failed. */
  status: number | null
  /** Time from navigation start to the load event, as the runner measured it. */
  loadMs: number
  page: Page
}

export interface CheckSuite {
  id: SuiteId
  /** Semver of the suite's code, reported in the run summary. */
  version: string
  requires: Capability[]
  rules: RuleMeta[]
  onPage?(ctx: SuiteCtx, page: CrawledPage): void | Promise<void>
  onSite?(ctx: SuiteCtx, site: SiteState): void | Promise<void>
  /**
   * Called once per selected page after the crawl, in Chromium. A suite that
   * `requires: ['browser']` makes the browser stage run. One that defines this
   * hook without requiring the browser never starts Chromium by itself: it
   * joins the stage only when another active suite caused it.
   */
  onBrowserPage?(ctx: SuiteCtx, page: BrowserPage): void | Promise<void>
  /** Which crawled pages get the browser stage; default: the shallowest 200 HTML pages, up to `sample`. */
  selectPages?(site: SiteState, config: Record<string, unknown>): string[]
  /** Pages for the default selection when the config sets no `sample`. */
  defaultSample?: number
}

/** Link outcomes that count as broken, by rule. Rate limiting and robots skips never do (COR-12). */
export function linkProblem(o: { status: number | null; error?: FetchError | undefined }): 'http' | 'timeout' | 'dns' | 'unreachable' | null {
  if (o.error === 'timeout') return 'timeout'
  if (o.error === 'dns_error') return 'dns'
  if (o.error === 'connection_error' || o.error === 'tls_error' || o.error === 'blocked_by_scope' || o.error === 'invalid_url') return 'unreachable'
  if (o.error) return null
  return o.status !== null && o.status >= 400 && o.status !== 429 ? 'http' : null
}
