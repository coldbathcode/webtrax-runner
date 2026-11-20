/**
 * Markdown for pull-request comments and for pasting into an LLM: stable
 * headings, no decoration, every finding with its id, URL, where it was seen
 * and the fix. The same input always gives the same text.
 */
import { SEVERITIES } from '@webtrax/protocol'
import { countsText, durationText, kilobytes, PROFILE_LABELS, scoreText, seconds, speedProfiles, statusText, target, type FindingGroup, type Report, type SpeedRow } from './model'

export interface MarkdownOptions { /** Findings per severity before "… and N more". Default 50. */ maxPerSeverity?: number }

const esc = (s: string) => s.replace(/([\\`*_[\]<>|])/g, '\\$1')
const code = (s: string) => `\`${s.replace(/`/g, "'")}\``

function evidenceLine(f: FindingGroup): string | null {
  const parts = Object.entries(f.evidence)
    .filter(([, v]) => v !== undefined && v !== '' && !(Array.isArray(v) && v.length === 0))
    .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(', ') : typeof v === 'object' ? JSON.stringify(v) : String(v)}`)
  return parts.length ? `  - Evidence: ${esc(parts.join('; '))}` : null
}

export function renderMarkdown(r: Report, o: MarkdownOptions = {}): string {
  const max = o.maxPerSeverity ?? 50
  const s = r.summary
  const out = [
    `## Webtrax report: ${target(r)}`,
    '',
    `- Status: ${statusText(r)}`,
    `- Pages crawled: ${s.pages.crawled}; links checked: ${s.links.checked}; duration: ${durationText(r)}`,
    ...(scoreText(r) ? [`- Health score: ${scoreText(r)} ([how it is worked out](https://docs.webtrax.dev/health-score/))`] : []),
    `- Findings: ${countsText(r.counts)}`,
    `- Suites: ${s.suites.map((x) => `${x.id} ${x.version}`).join(', ') || 'none'}`,
  ]
  for (const severity of SEVERITIES) {
    const group = r.findings.filter((f) => f.severity === severity)
    if (!group.length) continue
    out.push('', `### ${severity[0]!.toUpperCase()}${severity.slice(1)} (${group.length})`, '')
    for (const f of group.slice(0, max)) {
      out.push(`- **${esc(f.title)}** ${code(f.rule_id)} ${code(f.id)}`)
      out.push(`  - URL: ${f.url ? `<${f.url}>` : 'site-wide'}`)
      if (f.sources.length) out.push(`  - Seen on: ${f.sources.slice(0, 5).map((u) => `<${u}>`).join(', ')}${f.sources.length > 5 ? ` and ${f.sources.length - 5} more` : ''}`)
      const ev = evidenceLine(f)
      if (ev) out.push(ev)
      if (f.rule) out.push(`  - Fix: ${esc(f.rule.fix)}`)
    }
    if (group.length > max) out.push(`- … and ${group.length - max} more`)
  }
  if (!r.findings.length) out.push('', 'No findings.')
  // Lab speed by browser profile: the slowest pages first, so a short table shows what matters.
  const profiles = speedProfiles(r.speed)
  if (profiles.length) {
    const worst = (row: SpeedRow) => Math.max(...profiles.map((p) => row.profiles[p]?.lcp_ms ?? 0))
    const rows = [...r.speed].sort((a, b) => worst(b) - worst(a)).slice(0, 20)
    out.push('', '### Speed by device', '', 'Lab measurements from one load each (largest contentful paint, layout shift, page weight). Phone is Chromium as a mid-range phone on slow 4G, not a real device.', '')
    out.push(`| Page | ${profiles.map((p) => `${PROFILE_LABELS[p]} LCP | ${PROFILE_LABELS[p]} CLS | ${PROFILE_LABELS[p]} weight`).join(' | ')} |`)
    out.push(`|---|${profiles.map(() => '---|---|---|').join('')}`)
    for (const row of rows) out.push(`| <${row.url}> | ${profiles.map((p) => `${seconds(row.profiles[p]?.lcp_ms)} | ${row.profiles[p]?.cls ?? '—'} | ${kilobytes(row.profiles[p]?.transfer_bytes)}`).join(' | ')} |`)
    if (r.speed.length > rows.length) out.push('', `… and ${r.speed.length - rows.length} more pages in the JSON report.`)
  }
  return `${out.join('\n')}\n`
}
