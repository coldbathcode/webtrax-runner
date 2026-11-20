/**
 * The report model every reporter renders: a run's records, with findings
 * grouped by fingerprint (one entry per problem, with every page it was seen
 * on) and sorted most severe first. Built from the NDJSON records, so a
 * report can be rendered again later from `.webtrax/runs/<ts>/run.ndjson`.
 */
import { healthScore, SEVERITIES, severityRank, type FindingRecord, type HealthScore, type PageRecord, type RuleMeta, type RunLine, type Severity, type SummaryRecord } from '@webtrax/protocol'

type RunRecord = Extract<RunLine, { type: 'run' }>

export interface FindingGroup {
  /** Short, stable id shown to people and agents: the first 10 characters of the fingerprint. */
  id: string
  fingerprint: string
  rule_id: string
  severity: Severity
  title: string
  url: string | null
  /** Pages it was seen on (empty for page- and site-level findings). */
  sources: string[]
  evidence: Record<string, unknown>
  rule?: RuleMeta
}

export interface Report {
  run: RunRecord
  summary: SummaryRecord
  pages: PageRecord[]
  findings: FindingGroup[]
  /** Findings per severity, for headlines; equals summary.findings. */
  counts: Record<Severity, number>
  /** Health Score v1 (@webtrax/protocol): from the findings, the pages crawled and the suites that ran. No score for a failed run. */
  score: HealthScore
}

/** "87 out of 100 (B)", or null when there is no score. */
export const scoreText = (r: Report): string | null => (r.score.score === null ? null : `${r.score.score} out of 100 (${r.score.grade})`)

export const shortId = (fingerprint: string) => fingerprint.slice(0, 10)

export function buildReport(records: readonly RunLine[], rules: readonly RuleMeta[] = []): Report {
  const run = records.find((r): r is RunRecord => r.type === 'run')
  const summary = records.find((r): r is SummaryRecord => r.type === 'summary')
  if (!run || !summary) throw new Error('a run needs a run record and a summary record')
  const ruleMap = new Map(rules.map((r) => [r.id, r]))
  const groups = new Map<string, FindingGroup>()
  for (const f of records.filter((r): r is FindingRecord => r.type === 'finding')) {
    const g = groups.get(f.fingerprint)
    if (g) {
      if (f.source_url && !g.sources.includes(f.source_url)) g.sources.push(f.source_url)
      continue
    }
    const rule = ruleMap.get(f.rule_id)
    groups.set(f.fingerprint, {
      id: shortId(f.fingerprint), fingerprint: f.fingerprint, rule_id: f.rule_id, severity: f.severity, title: f.title, url: f.url,
      sources: f.source_url ? [f.source_url] : [], evidence: f.evidence, ...(rule ? { rule } : {}),
    })
  }
  const findings = [...groups.values()]
    .map((g) => ({ ...g, sources: [...g.sources].sort() }))
    .sort((a, b) => severityRank(a.severity) - severityRank(b.severity) || a.rule_id.localeCompare(b.rule_id) || (a.url ?? '').localeCompare(b.url ?? ''))
  const counts = Object.fromEntries(SEVERITIES.map((s) => [s, findings.filter((f) => f.severity === s).length])) as Record<Severity, number>
  const score = healthScore({
    findings: findings.map((f) => ({ rule_id: f.rule_id, suite: f.rule_id.split('.')[0]!, severity: f.severity, url: f.url })),
    pages: summary.pages.crawled,
    suites: summary.status === 'failed' ? [] : summary.suites.map((s) => s.id),
  })
  return { run, summary, pages: records.filter((r): r is PageRecord => r.type === 'page'), findings, counts, score }
}

/** "3 high, 1 medium" style text; "no findings" when empty. */
export function countsText(counts: Record<Severity, number>): string {
  const parts = SEVERITIES.filter((s) => counts[s] > 0).map((s) => `${counts[s]} ${s}`)
  return parts.length ? parts.join(', ') : 'no findings'
}

export const target = (r: Report) => r.run.spec.target.start_url

export const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

export function durationText(r: Report): string {
  const ms = Date.parse(r.summary.finished_at) - Date.parse(r.summary.started_at)
  return ms < 1000 ? `${ms} ms` : ms < 60_000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.floor(ms / 60_000)} min ${Math.round((ms % 60_000) / 1000)} s`
}

export function statusText(r: Report): string {
  const s = r.summary
  if (s.status === 'failed') return `failed (${(s.error ?? 'error').replace(/_/g, ' ')})`
  if (s.status === 'partial') return `partial (${(s.stop_reason ?? 'stopped').replace(/_/g, ' ')})`
  return s.status
}
