/**
 * JUnit XML for CI dashboards: one test suite per check suite, one failing
 * test case per finding (classname = rule id, name = URL), and a passing
 * "checked" case for a suite with no findings, so the dashboard shows it ran.
 */
import type { Report } from './model'

const xml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;')
  // XML 1.0 forbids most control characters, even escaped, so they are dropped on purpose.
  // eslint-disable-next-line no-control-regex
  .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')

export function renderJunit(r: Report): string {
  const seconds = Math.max(0, (Date.parse(r.summary.finished_at) - Date.parse(r.summary.started_at)) / 1000).toFixed(3)
  const suites = r.summary.suites.length ? r.summary.suites.map((s) => s.id) : [...new Set(r.findings.map((f) => f.rule_id.split('.')[0]!))]
  const blocks = suites.map((suite) => {
    const findings = r.findings.filter((f) => f.rule_id.startsWith(`${suite}.`))
    const cases = findings.length
      ? findings.map((f) => {
          const detail = [f.rule ? `How to fix: ${f.rule.fix}` : '', f.sources.length ? `Seen on: ${f.sources.join(', ')}` : '', Object.keys(f.evidence).length ? `Evidence: ${JSON.stringify(f.evidence)}` : ''].filter(Boolean).join('\n')
          return `    <testcase classname="${xml(f.rule_id)}" name="${xml(f.url ?? 'site-wide')}">\n      <failure type="${f.severity}" message="${xml(`${f.title} [${f.id}]`)}">${xml(detail)}</failure>\n    </testcase>`
        })
      : [`    <testcase classname="${xml(suite)}" name="${xml(r.run.spec.target.start_url)}"/>`]
    return `  <testsuite name="webtrax.${xml(suite)}" tests="${cases.length}" failures="${findings.length}" errors="0" skipped="0">\n${cases.join('\n')}\n  </testsuite>`
  })
  return `<?xml version="1.0" encoding="UTF-8"?>\n<testsuites name="Webtrax ${xml(r.run.spec.target.start_url)}" tests="${blocks.length ? r.findings.length + suites.filter((s) => !r.findings.some((f) => f.rule_id.startsWith(`${s}.`))).length : 0}" failures="${r.findings.length}" errors="${r.summary.status === 'failed' ? 1 : 0}" time="${seconds}">\n${blocks.join('\n')}\n</testsuites>\n`
}
