/**
 * Health Score v2 (C06.8, D20; plan/06-check-suites/ai-readiness-and-monitors.md §5
 * and browsers-and-devices.md).
 *
 * One number, 0 to 100, for a run: the same findings, pages and suites give
 * the same integer in the CLI, in a report rendered again later and in
 * Webtrax Cloud. Nothing here reads the network, the clock or Zod, so the
 * cloud app imports it as `@webtrax/protocol/score`.
 *
 * Per suite that ran:
 *
 *   penalty = Σ over (rule, severity) of weight(severity) × breadth
 *   breadth = 1 for a site-wide finding (no URL), otherwise
 *             min(1, 10 × places / pages checked)
 *   suite score = 100 × exp(−penalty / k), kept to one decimal
 *
 * and the health score is the suite scores' average, weighted by suite and
 * rounded to a whole number. Suites that did not run are left out, not
 * counted as perfect. `monitor` findings are shown but never scored.
 *
 * New in v2:
 *
 * - **Desktop and phone both count.** Speed and accessibility depend on the
 *   device, so when a run measured both, each is scored once per device (a
 *   finding counts for the devices it was seen on, at the severity it had
 *   there) and the suite's score is the mean of the two. With one device
 *   the score is that device's.
 * - **Pages checked is the suite's own.** Speed and accessibility look at a
 *   sample of pages in a browser and are judged against that sample (per
 *   device), not the whole crawl: a slow page among the ten measured is a
 *   tenth of them.
 *
 * A run with one device and no browser sample scores exactly as in v1.
 *
 * The constants are part of the published formula (docs: /health-score/).
 * Changing any of them, or the formula, means a new SCORE_VERSION.
 */
import type { BrowserProfileId, Severity, SuiteId } from './enums'

export const SCORE_VERSION = 2

/** Suites scored once per browser profile, because their results depend on the device. */
export const SCORE_PER_DEVICE: readonly SuiteId[] = ['performance', 'a11y']

/** What one rule costs at full breadth. Info findings never cost anything. */
export const SCORE_SEVERITY_WEIGHT: Record<Severity, number> = { critical: 10, high: 5, medium: 2, low: 0.5, info: 0 }

/** How much each suite counts in the average. A suite without a weight is not scored. */
export const SCORE_SUITE_WEIGHT: Partial<Record<SuiteId, number>> = { links: 25, performance: 20, security: 20, seo: 15, a11y: 15, content: 5, ai_readiness: 5 }

/**
 * How fast a suite's score falls: a penalty of k × ln(100/75), about 3.5,
 * scores 75. The same for every suite in v1; to be calibrated per suite from
 * real sites, with a new version.
 */
export const SCORE_K = 12

/** A finding spread over a tenth of the pages checked counts in full. */
export const SCORE_BREADTH = 10

export const GRADES = ['A', 'B', 'C', 'D', 'F'] as const
export type Grade = (typeof GRADES)[number]
export const gradeFor = (score: number): Grade => (score >= 90 ? 'A' : score >= 80 ? 'B' : score >= 70 ? 'C' : score >= 60 ? 'D' : 'F')

export interface ScoreFinding {
  rule_id: string; suite: string; severity: Severity; url: string | null
  /**
   * For a finding from a run with several browser profiles: its severity on
   * each profile it was seen on (the finding's `evidence.severity_by_profile`).
   * Absent, it counts on every profile at `severity`.
   */
  by_profile?: Partial<Record<BrowserProfileId, Severity>> | undefined
}

/** A suite that ran: its id, or with the pages it checked in a browser per profile (the summary's `suites[].pages`). */
export type ScoreSuite = string | { id: string; pages?: Partial<Record<BrowserProfileId, number>> | undefined; /** The suite never ran (the summary's `suites[].skipped`): it is left out, not scored as clean. */ skipped?: boolean | undefined }

export interface ScoreInput {
  /** The findings that count: open ones. Leave muted, accepted and fixed findings out. */
  findings: readonly ScoreFinding[]
  /** Pages the run checked (the summary's `pages.crawled`). */
  pages: number
  /** The suites that ran (the summary's `suites`). */
  suites: readonly ScoreSuite[]
}

export interface SuiteScore {
  suite: SuiteId; score: number; penalty: number; weight: number; rules: number
  /** For a suite scored per device on a run with several: each device's score (the suite's is their mean). */
  devices?: Partial<Record<BrowserProfileId, number>>
}

export interface HealthScore {
  version: typeof SCORE_VERSION
  /** Null when no scored suite ran. */
  score: number | null
  grade: Grade | null
  /** Scored suites that ran, in SCORE_SUITE_WEIGHT's order. */
  suites: SuiteScore[]
}

const round = (n: number, places: number) => Math.round(n * 10 ** places) / 10 ** places

/** One suite's penalty and rule count from the findings that count for it, against the pages it checked. */
function penaltyOf(findings: readonly { rule_id: string; severity: Severity; url: string | null }[], pages: number): { penalty: number; rules: number } {
  const groups = new Map<string, { severity: Severity; places: number; siteWide: boolean }>()
  for (const f of findings) {
    const key = `${f.rule_id}\n${f.severity}`
    const g = groups.get(key) ?? { severity: f.severity, places: 0, siteWide: false }
    g.places += 1
    if (f.url === null) g.siteWide = true
    groups.set(key, g)
  }
  let penalty = 0
  for (const g of groups.values()) penalty += (SCORE_SEVERITY_WEIGHT[g.severity] ?? 0) * (g.siteWide ? 1 : Math.min(1, (SCORE_BREADTH * g.places) / pages))
  return { penalty, rules: groups.size }
}
const scoreOf = (penalty: number) => round(100 * Math.exp(-penalty / SCORE_K), 1)
const count = (n: number | undefined, fallback: number) => Math.max(1, Math.floor(n ?? fallback) || 0)

export function healthScore(input: ScoreInput): HealthScore {
  const crawled = count(input.pages, 1)
  // A suite that was asked for and never ran says nothing: scoring it 100 would reward a broken check (V2-COR-07).
  const ran = new Map(input.suites.flatMap((x): [string, Partial<Record<BrowserProfileId, number>> | undefined][] => (typeof x === 'string' ? [[x, undefined]] : x.skipped ? [] : [[x.id, x.pages]])))
  const suites: SuiteScore[] = []
  for (const [suite, weight] of Object.entries(SCORE_SUITE_WEIGHT) as [SuiteId, number][]) {
    if (!ran.has(suite)) continue
    const mine = input.findings.filter((f) => f.suite === suite)
    // Only the browser suites are judged against their own sample; every other suite reads the whole crawl.
    const checked = SCORE_PER_DEVICE.includes(suite) ? ran.get(suite) : undefined
    const devices = (Object.keys(checked ?? {}) as BrowserProfileId[]).filter((d) => (checked?.[d] ?? 0) > 0)
    if (devices.length > 1) {
      // Once per device: what was seen there, at the severity it had there, against the pages checked there.
      const per = devices.map((d) => {
        const seen = mine.flatMap((f) => (f.by_profile ? (f.by_profile[d] ? [{ rule_id: f.rule_id, severity: f.by_profile[d]!, url: f.url }] : []) : [f]))
        return { d, ...penaltyOf(seen, count(checked![d], crawled)) }
      })
      const scores = per.map((x) => scoreOf(x.penalty))
      suites.push({
        suite, score: round(scores.reduce((a, b) => a + b, 0) / scores.length, 1), penalty: round(per.reduce((a, x) => a + x.penalty, 0) / per.length, 4), weight,
        rules: new Set(mine.map((f) => f.rule_id)).size, devices: Object.fromEntries(per.map((x, i) => [x.d, scores[i]!])),
      })
      continue
    }
    const { penalty, rules } = penaltyOf(mine, count(devices.length === 1 ? checked![devices[0]!] : undefined, crawled))
    suites.push({ suite, score: scoreOf(penalty), penalty: round(penalty, 4), weight, rules })
  }
  if (!suites.length) return { version: SCORE_VERSION, score: null, grade: null, suites }
  const total = suites.reduce((a, s) => a + s.weight, 0)
  const score = Math.round(suites.reduce((a, s) => a + s.weight * s.score, 0) / total)
  return { version: SCORE_VERSION, score, grade: gradeFor(score), suites }
}
