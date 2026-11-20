/**
 * Health Score v1 (C06.8; plan/06-check-suites/ai-readiness-and-monitors.md §5).
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
 * The constants are part of the published formula (docs: /health-score/).
 * Changing any of them, or the formula, means a new SCORE_VERSION.
 */
import type { Severity, SuiteId } from './enums'

export const SCORE_VERSION = 1

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

export interface ScoreFinding { rule_id: string; suite: string; severity: Severity; url: string | null }

export interface ScoreInput {
  /** The findings that count: open ones. Leave muted, accepted and fixed findings out. */
  findings: readonly ScoreFinding[]
  /** Pages the run checked (the summary's `pages.crawled`). */
  pages: number
  /** The suites that ran (the summary's `suites`). */
  suites: readonly string[]
}

export interface SuiteScore { suite: SuiteId; score: number; penalty: number; weight: number; rules: number }

export interface HealthScore {
  version: typeof SCORE_VERSION
  /** Null when no scored suite ran. */
  score: number | null
  grade: Grade | null
  /** Scored suites that ran, in SCORE_SUITE_WEIGHT's order. */
  suites: SuiteScore[]
}

const round = (n: number, places: number) => Math.round(n * 10 ** places) / 10 ** places

export function healthScore(input: ScoreInput): HealthScore {
  const pages = Math.max(1, Math.floor(input.pages) || 0)
  const ran = new Set(input.suites)
  const suites: SuiteScore[] = []
  for (const [suite, weight] of Object.entries(SCORE_SUITE_WEIGHT) as [SuiteId, number][]) {
    if (!ran.has(suite)) continue
    const groups = new Map<string, { severity: Severity; places: number; siteWide: boolean }>()
    for (const f of input.findings) {
      if (f.suite !== suite) continue
      const key = `${f.rule_id}\n${f.severity}`
      const g = groups.get(key) ?? { severity: f.severity, places: 0, siteWide: false }
      g.places += 1
      if (f.url === null) g.siteWide = true
      groups.set(key, g)
    }
    let penalty = 0
    for (const g of groups.values()) penalty += (SCORE_SEVERITY_WEIGHT[g.severity] ?? 0) * (g.siteWide ? 1 : Math.min(1, (SCORE_BREADTH * g.places) / pages))
    suites.push({ suite, score: round(100 * Math.exp(-penalty / SCORE_K), 1), penalty: round(penalty, 4), weight, rules: groups.size })
  }
  if (!suites.length) return { version: SCORE_VERSION, score: null, grade: null, suites }
  const total = suites.reduce((a, s) => a + s.weight, 0)
  const score = Math.round(suites.reduce((a, s) => a + s.weight * s.score, 0) / total)
  return { version: SCORE_VERSION, score, grade: gradeFor(score), suites }
}
