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
  /** One guarded GET that does not follow redirects (for checks such as HTTP → HTTPS). */
  request(url: string): Promise<Outcome>
}

export interface CheckSuite {
  id: SuiteId
  /** Semver of the suite's code, reported in the run summary. */
  version: string
  requires: Capability[]
  rules: RuleMeta[]
  onPage?(ctx: SuiteCtx, page: CrawledPage): void | Promise<void>
  onSite?(ctx: SuiteCtx, site: SiteState): void | Promise<void>
}

/** Link outcomes that count as broken, by rule. Rate limiting and robots skips never do (COR-12). */
export function linkProblem(o: { status: number | null; error?: FetchError | undefined }): 'http' | 'timeout' | 'dns' | 'unreachable' | null {
  if (o.error === 'timeout') return 'timeout'
  if (o.error === 'dns_error') return 'dns'
  if (o.error === 'connection_error' || o.error === 'tls_error' || o.error === 'blocked_by_scope' || o.error === 'invalid_url') return 'unreachable'
  if (o.error) return null
  return o.status !== null && o.status >= 400 && o.status !== 429 ? 'http' : null
}
