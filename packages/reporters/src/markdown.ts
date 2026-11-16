/**
 * Markdown for pull-request comments and for pasting into an LLM: stable
 * headings, no decoration, every finding with its id, URL, where it was seen
 * and the fix. The same input always gives the same text.
 */
import { SEVERITIES } from '@webtrax/protocol'
import { countsText, durationText, statusText, target, type FindingGroup, type Report } from './model'

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
  return `${out.join('\n')}\n`
}
