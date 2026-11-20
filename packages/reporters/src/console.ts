/** The terminal summary `webtrax check` prints. Plain text; colour only when asked (a TTY). */
import type { Severity } from '@webtrax/protocol'
import { countsText, durationText, plural, scoreText, statusText, target, type Report } from './model'

const COLOURS: Record<Severity, string> = { critical: '\x1b[35m', high: '\x1b[31m', medium: '\x1b[33m', low: '\x1b[36m', info: '\x1b[2m' }

export interface ConsoleOptions { color?: boolean; /** Findings listed before "… and N more". Default 20. */ max?: number; reportPath?: string }

export function renderConsole(r: Report, o: ConsoleOptions = {}): string {
  const c = (s: Severity, text: string) => (o.color ? `${COLOURS[s]}${text}\x1b[0m` : text)
  const bold = (text: string) => (o.color ? `\x1b[1m${text}\x1b[0m` : text)
  const max = o.max ?? 20
  const s = r.summary
  const lines = [
    `${bold('Webtrax')} ${target(r)}`,
    `${statusText(r)} · ${plural(s.pages.crawled, 'page')} · ${plural(s.links.checked, 'link')} checked · ${durationText(r)}`,
    `${countsText(r.counts)}`,
  ]
  const score = scoreText(r)
  if (score) lines.push(`Health ${score}`)
  if (r.findings.length) lines.push('')
  for (const f of r.findings.slice(0, max)) {
    const where = f.url ?? 'site-wide'
    const from = f.sources.length ? ` (on ${f.sources.length === 1 ? f.sources[0] : `${f.sources.length} pages`})` : ''
    lines.push(`${c(f.severity, f.severity.toUpperCase().padEnd(8))} ${f.title}: ${where}${from}  [${f.id}]`)
  }
  if (r.findings.length > max) lines.push(`… and ${r.findings.length - max} more`)
  if (o.reportPath) lines.push('', `Report: ${o.reportPath}`)
  return `${lines.join('\n')}\n`
}
