/**
 * SARIF 2.1.0, for GitHub code scanning and other security tooling. One
 * result per finding (grouped by fingerprint, like every other report), with
 * the page URL as its location and the fingerprint as a partial fingerprint
 * so the same problem is tracked across runs. Checked against the official
 * OASIS schema in test/sarif.test.ts.
 */
import type { Severity } from '@webtrax/protocol'
import type { Report } from './model'

const LEVEL: Record<Severity, 'error' | 'warning' | 'note'> = { critical: 'error', high: 'error', medium: 'warning', low: 'note', info: 'note' }
/** GitHub orders security alerts by this property (0–10). */
const SECURITY_SEVERITY: Record<Severity, string> = { critical: '9.5', high: '8.0', medium: '5.5', low: '3.0', info: '0.0' }

export function renderSarif(r: Report): string {
  const ruleIds = [...new Set(r.findings.map((f) => f.rule_id))].sort()
  const rules = ruleIds.map((id) => {
    const finding = r.findings.find((f) => f.rule_id === id)!
    const meta = finding.rule
    const suite = id.split('.')[0]!
    return {
      id,
      name: id.replace(/[._]+(.)/g, (_, c: string) => c.toUpperCase()),
      shortDescription: { text: meta?.title ?? finding.title },
      ...(meta ? { fullDescription: { text: meta.why }, help: { text: meta.fix, markdown: `**Why it matters.** ${meta.why}\n\n**How to fix.** ${meta.fix}` }, helpUri: `https://docs.webtrax.dev/rules/${meta.docs_slug}/` } : {}),
      defaultConfiguration: { level: LEVEL[meta?.severity ?? finding.severity] },
      properties: { tags: [suite, 'website'], ...(suite === 'security' ? { 'security-severity': SECURITY_SEVERITY[meta?.severity ?? finding.severity] } : {}) },
    }
  })
  const index = new Map(ruleIds.map((id, i) => [id, i]))
  const results = r.findings.map((f) => {
    const where = f.url ?? r.run.spec.target.start_url
    const seen = f.sources.length ? ` Seen on ${f.sources.length} page${f.sources.length === 1 ? '' : 's'}: ${f.sources.slice(0, 5).join(', ')}${f.sources.length > 5 ? ', …' : ''}.` : ''
    return {
      ruleId: f.rule_id,
      ruleIndex: index.get(f.rule_id)!,
      level: LEVEL[f.severity],
      message: { text: `${f.title}: ${where}.${seen}` },
      locations: [{ physicalLocation: { artifactLocation: { uri: where } } }],
      ...(f.sources.length ? { relatedLocations: f.sources.slice(0, 20).map((u, id) => ({ id, physicalLocation: { artifactLocation: { uri: u } }, message: { text: 'Linked from this page' } })) } : {}),
      partialFingerprints: { 'webtrax/v1': f.fingerprint },
      properties: { severity: f.severity, finding_id: f.id, ...(Object.keys(f.evidence).length ? { evidence: f.evidence } : {}) },
    }
  })
  const sarif = {
    $schema: 'https://json.schemastore.org/sarif-2.1.0.json',
    version: '2.1.0',
    runs: [{
      tool: { driver: { name: 'Webtrax', informationUri: 'https://webtrax.dev/', semanticVersion: r.run.runner.version.replace(/[^0-9A-Za-z.+-]/g, ''), rules } },
      invocations: [{ executionSuccessful: r.summary.status !== 'failed', startTimeUtc: r.summary.started_at, endTimeUtc: r.summary.finished_at }],
      automationDetails: { id: `webtrax/${new URL(r.run.spec.target.start_url).host}/` },
      results,
    }],
  }
  return `${JSON.stringify(sarif, null, 2)}\n`
}
