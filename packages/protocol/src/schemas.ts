/**
 * The runner protocol, version 1 (C05.1). Every record a run produces, and
 * the job spec that starts it, is defined here once. The CLI writes these as
 * NDJSON, the reporters read them, and the cloud ingests them (C04.5) into
 * `scans`, `pages`, `findings`, `finding_occurrences` and `metrics`
 * (packages/db migration 0001). JSON Schema is generated from these
 * (`pnpm gen:schema`), so non-TypeScript tools can validate the same files.
 *
 * Records are snake_case on the wire, like the database. Unknown keys are
 * stripped on parse, so newer runners can add fields without breaking older
 * readers.
 */
import { z } from 'zod'
import { BROWSER_PROFILES, CAPABILITIES, FETCH_ERRORS, PROTOCOL_VERSION, RUN_ERRORS, RUN_STATUSES, SEVERITIES, STOP_REASONS, SUITES } from './enums'

/** Evidence is capped at 2 KB of JSON, as the database enforces (`finding_occurrences.evidence`). */
export const MAX_EVIDENCE_BYTES = 2048
export const SNAPSHOT_LIMITS = { textBytes: 50_000, domBytes: 200_000, linksOut: 500, images: 500 } as const

const byteLength = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length

export const HttpUrl = z.url({ protocol: /^https?$/, normalize: false }).regex(/^https?:\/\//i, "an http(s) URL").max(4096)
export const SuiteEnum = z.enum(SUITES)
export const SeverityEnum = z.enum(SEVERITIES)
export const Fingerprint = z.string().regex(/^[0-9a-f]{64}$/, 'a sha256 hex digest')
/** `<suite>.<rule>[.<variant>]`, e.g. `links.broken.internal`. */
export const RuleId = z.string().regex(/^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$/, 'suite.rule, lowercase, dot-separated')
export const IsoDateTime = z.iso.datetime({ offset: true })

/** A secret is never inlined in a cloud spec: it is a reference the runner resolves (`env:NAME`, `vault:…`). */
export const SecretRef = z.object({ ref: z.string().regex(/^(env|vault|file):.+/) })
/** The CLI may pass a literal value; agent mode only accepts references. */
export const SecretValue = z.union([z.string(), SecretRef])

export const SuiteConfig = z.object({
  enabled: z.boolean().default(true),
  config: z.record(z.string(), z.unknown()).default({}),
})

export const JobSpec = z.object({
  spec_version: z.literal(1),
  job_id: z.string().min(1).max(100),
  target: z.object({
    start_url: HttpUrl,
    /** Explicit URLs to check instead of discovering pages (verify-after-fix, `audit_page`). */
    urls: z.array(HttpUrl).max(1000).optional(),
  }),
  scope: z
    .object({
      /** URL path prefixes or glob patterns to crawl; empty means the whole origin. */
      include: z.array(z.string()).default([]),
      exclude: z.array(z.string()).default([]),
      /** Check external links for reachability (never crawled). */
      check_external: z.boolean().default(true),
      /** Allow private, loopback and link-local targets (local dev, `webtrax mcp`). Off for cloud jobs. */
      allow_private: z.boolean().default(false),
      respect_robots: z.boolean().default(true),
    })
    .default({ include: [], exclude: [], check_external: true, allow_private: false, respect_robots: true }),
  limits: z
    .object({
      max_pages: z.int().min(1).max(100_000).default(300),
      max_depth: z.int().min(0).max(100).default(10),
      concurrency: z.int().min(1).max(64).default(4),
      per_host_rps: z.number().positive().max(50).default(2),
      time_budget_s: z.int().min(10).max(86_400).default(600),
    })
    .default({ max_pages: 300, max_depth: 10, concurrency: 4, per_host_rps: 2, time_budget_s: 600 }),
  suites: z.partialRecord(SuiteEnum, SuiteConfig).default({ links: { enabled: true, config: {} } }),
  auth: z
    .object({
      headers: z.record(z.string(), SecretValue).optional(),
      basic: z.object({ username: z.string(), password: SecretValue }).optional(),
      cookies: z.array(z.object({ name: z.string(), value: SecretValue, domain: z.string().optional() })).optional(),
    })
    .optional(),
  /**
   * The browser stage's profiles (C06.10), in order; the first is the main one,
   * which every browser suite sees. `extra_profile_pages` caps how many pages
   * each further profile loads (shallowest first; default: the same pages).
   */
  browser: z
    .object({
      profiles: z.array(z.enum(BROWSER_PROFILES)).min(1).max(BROWSER_PROFILES.length).default(['desktop']),
      extra_profile_pages: z.int().min(1).max(1000).optional(),
    })
    .default({ profiles: ['desktop'] }),
  /** Defaults to the WebtraxBot identity (`@webtrax/protocol/bot`). */
  user_agent: z.string().max(500).optional(),
  evidence: z.enum(['minimal', 'standard', 'full']).default('standard'),
  snapshot: z.object({ enabled: z.boolean(), redact: z.enum(['strict', 'standard', 'off']) }).optional(),
  labels: z.record(z.string(), z.string()).default({}),
})
export type JobSpec = z.output<typeof JobSpec>
export type JobSpecInput = z.input<typeof JobSpec>

export const RuleMeta = z.object({
  id: RuleId,
  suite: SuiteEnum,
  title: z.string().min(1).max(200),
  /** Bumped when the rule's meaning changes; stored as `findings.rule_version`. */
  version: z.int().min(1),
  severity: SeverityEnum,
  /** Why it matters, in one or two sentences. */
  why: z.string().min(1),
  /** How to fix it: vetted guidance the AI layer starts from (C11). */
  fix: z.string().min(1),
  docs_slug: z.string().regex(/^[a-z0-9-]+$/),
  tags: z.array(z.string()).default([]),
})
export type RuleMeta = z.output<typeof RuleMeta>

const Evidence = z
  .record(z.string(), z.unknown())
  .refine((e) => byteLength(e) <= MAX_EVIDENCE_BYTES, `evidence must be at most ${MAX_EVIDENCE_BYTES} bytes of JSON`)

export const RunRecord = z.object({
  type: z.literal('run'),
  protocol_version: z.literal(PROTOCOL_VERSION),
  job_id: z.string(),
  started_at: IsoDateTime,
  runner: z.object({ name: z.string(), version: z.string() }),
  user_agent: z.string(),
  spec: JobSpec,
})

export const FindingRecord = z
  .object({
    type: z.literal('finding'),
    fingerprint: Fingerprint,
    suite: SuiteEnum,
    rule_id: RuleId,
    rule_version: z.int().min(1),
    severity: SeverityEnum,
    /** What the finding is about: the broken link's target, or the page missing a header. Null for site-wide findings. */
    url: HttpUrl.nullable(),
    /** The page it was seen on, when that differs from `url` (a broken link's source page). */
    source_url: HttpUrl.optional(),
    title: z.string().min(1).max(300),
    evidence: Evidence.default({}),
  })
  .refine((f) => f.rule_id.split('.')[0] === f.suite, { message: 'rule_id must start with its suite', path: ['rule_id'] })
export type FindingRecord = z.output<typeof FindingRecord>

export const MetricRecord = z.object({
  type: z.literal('metric'),
  name: z.string().regex(/^[a-z][a-z0-9_]*$/),
  value: z.number(),
  unit: z.string().max(20).optional(),
  url: HttpUrl,
  device: z.enum(['desktop', 'mobile']).default('desktop'),
  /** The browser profile it was measured with (C06.10); absent on records from before profiles. */
  profile: z.enum(BROWSER_PROFILES).optional(),
})
export type MetricRecord = z.output<typeof MetricRecord>

export const PageRecord = z.object({
  type: z.literal('page'),
  url: HttpUrl,
  final_url: HttpUrl,
  /** HTTP status of the final response; null when no response arrived (see `error`). */
  status: z.int().min(100).max(599).nullable(),
  error: z.enum(FETCH_ERRORS).optional(),
  redirect_chain: z.array(z.object({ url: HttpUrl, status: z.int().min(300).max(399) })).default([]),
  content_type: z.string().max(200).optional(),
  depth: z.int().min(0),
  timing_ms: z.object({ ttfb: z.number().min(0), total: z.number().min(0) }).optional(),
  title: z.string().max(1000).optional(),
  content_hash: Fingerprint.optional(),
})
export type PageRecord = z.output<typeof PageRecord>

export const SnapshotRecord = z.object({
  type: z.literal('snapshot'),
  url: HttpUrl,
  final_url: HttpUrl,
  status: z.int().min(100).max(599),
  content_hash: Fingerprint,
  /** Hash of the layout skeleton; groups pages built from one template. */
  template_key: z.string().max(100),
  /** Allowlisted response headers; `set-cookie` keeps names and attributes only. */
  headers: z.record(z.string(), z.string()),
  meta: z.object({
    title: z.string().optional(),
    description: z.string().optional(),
    canonical: z.string().optional(),
    robots: z.string().optional(),
    lang: z.string().optional(),
    hreflang: z.array(z.object({ lang: z.string(), href: z.string() })).default([]),
    og: z.record(z.string(), z.string()).default({}),
    schema_types: z.array(z.string()).default([]),
    headings: z.array(z.object({ level: z.int().min(1).max(6), text: z.string() })).default([]),
    word_count: z.int().min(0),
  }),
  text: z.string().refine((t) => new TextEncoder().encode(t).length <= SNAPSHOT_LIMITS.textBytes, 'text is capped at 50 KB'),
  dom: z.string().refine((t) => new TextEncoder().encode(t).length <= SNAPSHOT_LIMITS.domBytes, 'dom is capped at 200 KB'),
  links_out: z.array(z.object({ href: z.string(), text: z.string(), rel: z.string().optional() })).max(SNAPSHOT_LIMITS.linksOut),
  images: z
    .array(z.object({ src: z.string(), alt: z.string().optional(), width: z.number().optional(), height: z.number().optional(), bytes: z.number().optional() }))
    .max(SNAPSHOT_LIMITS.images),
  forms: z.array(z.object({ action: z.string(), method: z.string(), has_password: z.boolean() })).default([]),
  /** Which redaction ran before the snapshot left the runner (guardrail family G-D). */
  redaction: z.enum(['strict', 'standard', 'off']),
})
export type SnapshotRecord = z.output<typeof SnapshotRecord>

export const ArtifactRecord = z.object({
  type: z.literal('artifact'),
  kind: z.enum(['report_html', 'report_json', 'report_md', 'screenshot', 'lighthouse', 'har', 'other']),
  /** Path relative to the run directory, or an uploaded object's URL. */
  location: z.string().min(1),
  content_type: z.string(),
  bytes: z.int().min(0),
  sha256: Fingerprint.optional(),
  url: HttpUrl.optional(),
})
export type ArtifactRecord = z.output<typeof ArtifactRecord>

const SeverityCounts = z.object({ critical: z.int().min(0), high: z.int().min(0), medium: z.int().min(0), low: z.int().min(0), info: z.int().min(0) })

export const SummaryRecord = z.object({
  type: z.literal('summary'),
  job_id: z.string(),
  status: z.enum(RUN_STATUSES),
  error: z.enum(RUN_ERRORS).optional(),
  /**
   * The start page's response, set when the run failed on it
   * (`start_url_unreachable`): its HTTP status, or null with the fetch error
   * when no response arrived. Lets a report say "returned 403" or "timed out".
   */
  start: z.object({ status: z.int().min(100).max(599).nullable(), error: z.enum(FETCH_ERRORS).optional() }).optional(),
  /** Set when `status` is `partial`. */
  stop_reason: z.enum(STOP_REASONS).optional(),
  started_at: IsoDateTime,
  finished_at: IsoDateTime,
  pages: z.object({ crawled: z.int().min(0), failed: z.int().min(0) }),
  links: z.object({ checked: z.int().min(0), broken: z.int().min(0) }),
  findings: SeverityCounts,
  suites: z.array(z.object({
    id: SuiteEnum, version: z.string(), requires: z.array(z.enum(CAPABILITIES)),
    /**
     * False when the suite's results are not the whole picture: one of its
     * hooks threw, or the browser stage it needs did not run. Its findings
     * still stand; what it did not report is not evidence of a fix, and a
     * suite that never ran at all is left out of the health score.
     */
    complete: z.boolean().optional(),
    /** True when the suite produced nothing because the stage it needs never ran (the browser failed to start, or the run stopped first). */
    skipped: z.boolean().optional(),
    /** For a suite that ran in the browser stage: the pages it looked at, per browser profile (Health Score v2). */
    pages: z.partialRecord(z.enum(BROWSER_PROFILES), z.int().min(0)).optional(),
  })),
})
export type SummaryRecord = z.output<typeof SummaryRecord>

/**
 * One line of a run's NDJSON. A run is: one `run` record first, then pages,
 * findings, metrics, snapshots and artifacts in any order, then one `summary`.
 */
export const RunLine = z.discriminatedUnion('type', [RunRecord, PageRecord, FindingRecord, MetricRecord, SnapshotRecord, ArtifactRecord, SummaryRecord])
export type RunLine = z.output<typeof RunLine>
export type RunLineType = RunLine['type']
