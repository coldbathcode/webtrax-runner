/**
 * The report model every reporter renders: a run's records, with findings
 * grouped by fingerprint (one entry per problem, with every page it was seen
 * on) and sorted most severe first. Built from the NDJSON records, so a
 * report can be rendered again later from `.webtrax/runs/<ts>/run.ndjson`.
 */
import { BROWSER_PROFILES, healthScore, SCAN_PROFILE, SEVERITIES, severityRank, type BrowserProfileId, type FindingRecord, type HealthScore, type PageRecord, type RuleMeta, type RunLine, type Severity, type SummaryRecord } from '@webtrax/protocol'

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
  /** Lab speed per page and browser profile (C06.10), pages in crawl order; empty without the performance suite. */
  speed: SpeedRow[]
  /** Health Score v1 (@webtrax/protocol): from the findings, the pages crawled and the suites that ran. No score for a failed run. */
  score: HealthScore
}

/** "87 out of 100 (B)", or null when there is no score. */
export const scoreText = (r: Report): string | null => (r.score.score === null ? null : `${r.score.score} out of 100 (${r.score.grade})`)

export interface SpeedValues { lcp_ms?: number; cls?: number; ttfb_ms?: number; transfer_bytes?: number; load_ms?: number }
export interface SpeedRow { url: string; profiles: Partial<Record<BrowserProfileId, SpeedValues>> }
const SPEED_METRICS = new Set(['lcp_ms', 'cls', 'ttfb_ms', 'transfer_bytes', 'load_ms'])
export const PROFILE_LABELS: Record<BrowserProfileId, string> = { desktop: 'Desktop', phone: 'Phone', 'webkit-desktop': 'WebKit (Safari\'s engine), desktop size', 'webkit-phone': 'WebKit (Safari\'s engine), phone size', 'firefox-desktop': 'Firefox, desktop size' }

/** The run's speed metrics by page, then by the profile that measured them (records without one are desktop). */
export function speedRows(records: readonly RunLine[]): SpeedRow[] {
  const rows = new Map<string, SpeedRow>()
  for (const m of records) {
    if (m.type !== 'metric' || !SPEED_METRICS.has(m.name)) continue
    const row = rows.get(m.url) ?? { url: m.url, profiles: {} }
    rows.set(m.url, row)
    const values = (row.profiles[m.profile ?? 'desktop'] ??= {})
    values[m.name as keyof SpeedValues] = m.value
  }
  return [...rows.values()]
}
/** The profiles a run measured, desktop first. */
export const speedProfiles = (rows: readonly SpeedRow[]): BrowserProfileId[] => BROWSER_PROFILES.filter((p) => rows.some((r) => r.profiles[p]))
export const seconds = (ms: number | undefined) => (ms === undefined ? '—' : `${(ms / 1000).toFixed(ms < 9950 ? 1 : 0)} s`)
export const kilobytes = (bytes: number | undefined) => (bytes === undefined ? '—' : bytes >= 1_000_000 ? `${(bytes / 1_000_000).toFixed(1)} MB` : `${Math.round(bytes / 1000)} kB`)

/** A finding's severity on each browser profile it was seen on (`evidence.severity_by_profile`), when the run had several. */
export function severityByProfile(evidence: Record<string, unknown>): Partial<Record<BrowserProfileId, Severity>> | undefined {
  const raw = evidence.severity_by_profile
  if (!raw || typeof raw !== 'object') return undefined
  const out: Partial<Record<BrowserProfileId, Severity>> = {}
  for (const p of BROWSER_PROFILES) {
    const s = (raw as Record<string, unknown>)[p]
    if (typeof s === 'string' && (SEVERITIES as readonly string[]).includes(s)) out[p] = s as Severity
  }
  return Object.keys(out).length ? out : undefined
}

/**
 * What the run could not vouch for, in a sentence, or null: checks that did
 * not finish, and a crawl that stopped at one of its own limits. A reader
 * must not take silence from these as a clean result.
 */
export function caveatText(summary: SummaryRecord): string | null {
  const parts: string[] = []
  const skipped = summary.suites.filter((s) => s.skipped).map((s) => s.id)
  const incomplete = summary.suites.filter((s) => s.complete === false && !s.skipped).map((s) => s.id)
  if (skipped.length) parts.push(`Did not run: ${skipped.join(', ')}.`)
  if (incomplete.length) parts.push(`Ran with errors, so may have missed issues: ${incomplete.join(', ')}.`)
  if (summary.stop_reason === 'page_limit') parts.push('The site has more pages than this run may crawl: the rest were not checked.')
  if (summary.stop_reason === 'depth_limit') parts.push('Some pages are deeper than this run may follow links: they were not checked.')
  if (summary.stop_reason === 'page_truncated') parts.push('A page was larger than the size limit and was read only in part.')
  const own = summary.walls?.find((w) => w.origin)
  if (summary.stop_reason === 'blocked' || own) parts.push(`The site's ${own?.by ? `${own.by} ` : ''}firewall refused the scanner part way through, so it stopped asking: pages it refused were not checked. Let it in with a rule in your firewall (https://webtrax.dev/bot#firewall-pass) and run again.`)
  const others = (summary.walls ?? []).filter((w) => !w.origin)
  if (others.length) parts.push(`Bot protection on ${others.slice(0, 3).map((w) => `${w.host}${w.by ? ` (${w.by})` : ''}`).join(', ')}${others.length > 3 ? ` and ${others.length - 3} more` : ''} refused the link checks: links there could not be verified, and none is counted as broken.`)
  return parts.length ? parts.join(' ') : null
}

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
    findings: findings.map((f) => ({ rule_id: f.rule_id, suite: f.rule_id.split('.')[0]!, severity: f.severity, url: f.url, by_profile: severityByProfile(f.evidence) })),
    pages: summary.pages.crawled,
    suites: summary.status === 'failed' ? [] : summary.suites.map((s) => ({ id: s.id, pages: s.pages, skipped: s.skipped })),
  })
  return { run, summary, pages: records.filter((r): r is PageRecord => r.type === 'page'), findings, counts, score, speed: speedRows(records) }
}

/** "3 high, 1 medium" style text; "no findings" when empty. */
export function countsText(counts: Record<Severity, number>): string {
  const parts = SEVERITIES.filter((s) => counts[s] > 0).map((s) => `${counts[s]} ${s}`)
  return parts.length ? parts.join(', ') : 'no findings'
}

export const target = (r: Report) => r.run.spec.target.start_url

/** The scan profile's name ("Quick check"), or null for a run whose settings were chosen by hand. */
export const profileText = (r: Report): string | null => {
  const p = r.run.spec.profile
  if (!p || p === 'custom') return null
  const urls = r.run.spec.target.urls?.length
  return `${SCAN_PROFILE[p].label}${urls ? ` of ${plural(urls, 'URL')}` : ''}${r.run.spec.rules?.length ? `, rules ${r.run.spec.rules.join(', ')}` : ''}`
}

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
