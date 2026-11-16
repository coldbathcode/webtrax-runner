import { describe, expect, it } from 'vitest'
import {
  ArtifactRecord, FindingRecord, JobSpec, MAX_EVIDENCE_BYTES, MetricRecord, PageRecord, RuleMeta, RunLine, RunRecord,
  SnapshotRecord, SummaryRecord, atLeast, severityRank,
} from '../src'

const HEX = 'a'.repeat(64)
const finding = {
  type: 'finding', fingerprint: HEX, suite: 'links', rule_id: 'links.broken.internal', rule_version: 1, severity: 'high',
  url: 'https://example.com/missing', source_url: 'https://example.com/', title: 'Broken internal link', evidence: { status: 404 },
}
const page = { type: 'page', url: 'https://example.com/', final_url: 'https://example.com/', status: 200, depth: 0 }
const summary = {
  type: 'summary', job_id: 'j1', status: 'completed', started_at: '2026-11-16T10:00:00Z', finished_at: '2026-11-16T10:01:00.500Z',
  pages: { crawled: 12, failed: 0 }, links: { checked: 100, broken: 1 }, findings: { critical: 0, high: 1, medium: 0, low: 0, info: 0 },
  suites: [{ id: 'links', version: '1.0.0', requires: ['http'] }],
}

describe('JobSpec', () => {
  it('fills safe defaults from the minimum', () => {
    const spec = JobSpec.parse({ spec_version: 1, job_id: 'j1', target: { start_url: 'https://example.com' } })
    expect(spec.scope).toMatchObject({ allow_private: false, respect_robots: true, check_external: true })
    expect(spec.limits).toMatchObject({ max_pages: 300, concurrency: 4, per_host_rps: 2, time_budget_s: 600 })
    expect(spec.suites).toEqual({ links: { enabled: true, config: {} } })
    expect(spec.evidence).toBe('standard')
  })

  it('rejects non-http targets, unknown suites, a wrong version and silly limits', () => {
    const base = { spec_version: 1, job_id: 'j1', target: { start_url: 'https://example.com' } }
    expect(JobSpec.safeParse({ ...base, target: { start_url: 'ftp://example.com' } }).success).toBe(false)
    expect(JobSpec.safeParse({ ...base, target: { start_url: 'javascript:alert(1)' } }).success).toBe(false)
    expect(JobSpec.safeParse({ ...base, suites: { spelling: { enabled: true } } }).success).toBe(false)
    expect(JobSpec.safeParse({ ...base, spec_version: 2 }).success).toBe(false)
    expect(JobSpec.safeParse({ ...base, limits: { max_pages: 0 } }).success).toBe(false)
  })

  it('takes secrets as literals or references, and only known reference kinds', () => {
    const base = { spec_version: 1, job_id: 'j1', target: { start_url: 'https://example.com' } }
    expect(JobSpec.safeParse({ ...base, auth: { headers: { Authorization: { ref: 'env:TOKEN' } } } }).success).toBe(true)
    expect(JobSpec.safeParse({ ...base, auth: { basic: { username: 'u', password: 'p' } } }).success).toBe(true)
    expect(JobSpec.safeParse({ ...base, auth: { headers: { Authorization: { ref: 'http://evil' } } } }).success).toBe(false)
  })
})

describe('FindingRecord', () => {
  it('accepts a well-formed finding', () => expect(FindingRecord.parse(finding)).toMatchObject({ rule_id: 'links.broken.internal' }))

  it('requires the rule to belong to its suite', () => {
    const r = FindingRecord.safeParse({ ...finding, suite: 'security' })
    expect(r.success).toBe(false)
    expect(r.error?.issues[0]?.path).toEqual(['rule_id'])
  })

  it('rejects a bad fingerprint, rule id or severity', () => {
    expect(FindingRecord.safeParse({ ...finding, fingerprint: 'abc' }).success).toBe(false)
    expect(FindingRecord.safeParse({ ...finding, rule_id: 'Links.Broken' }).success).toBe(false)
    expect(FindingRecord.safeParse({ ...finding, rule_id: 'links' }).success).toBe(false)
    expect(FindingRecord.safeParse({ ...finding, severity: 'urgent' }).success).toBe(false)
  })

  it('caps evidence at the database limit', () => {
    expect(FindingRecord.safeParse({ ...finding, evidence: { s: 'x'.repeat(MAX_EVIDENCE_BYTES) } }).success).toBe(false)
    expect(FindingRecord.safeParse({ ...finding, evidence: { s: 'x'.repeat(MAX_EVIDENCE_BYTES - 20) } }).success).toBe(true)
  })

  it('allows site-wide findings with no URL', () => expect(FindingRecord.safeParse({ ...finding, url: null }).success).toBe(true))
})

describe('other records', () => {
  it('page: a response, or an error with no status', () => {
    expect(PageRecord.safeParse(page).success).toBe(true)
    expect(PageRecord.safeParse({ ...page, status: null, error: 'dns_error' }).success).toBe(true)
    expect(PageRecord.safeParse({ ...page, status: 99 }).success).toBe(false)
    expect(PageRecord.safeParse({ ...page, redirect_chain: [{ url: 'https://example.com/a', status: 200 }] }).success).toBe(false)
  })

  it('metric: snake_case names', () => {
    expect(MetricRecord.safeParse({ type: 'metric', name: 'lcp_ms', value: 1200, unit: 'ms', url: 'https://example.com/' }).success).toBe(true)
    expect(MetricRecord.safeParse({ type: 'metric', name: 'LCP', value: 1, url: 'https://example.com/' }).success).toBe(false)
  })

  it('snapshot: text and DOM size caps', () => {
    const snap = {
      type: 'snapshot', url: 'https://example.com/', final_url: 'https://example.com/', status: 200, content_hash: HEX, template_key: 't',
      headers: {}, meta: { word_count: 3 }, text: 'Hello there world', dom: '<main>Hello</main>', links_out: [], images: [], redaction: 'standard',
    }
    expect(SnapshotRecord.safeParse(snap).success).toBe(true)
    expect(SnapshotRecord.safeParse({ ...snap, text: 'x'.repeat(50_001) }).success).toBe(false)
  })

  it('artifact, run and summary', () => {
    expect(ArtifactRecord.safeParse({ type: 'artifact', kind: 'report_html', location: 'report.html', content_type: 'text/html', bytes: 10 }).success).toBe(true)
    expect(RunRecord.safeParse({
      type: 'run', protocol_version: 1, job_id: 'j1', started_at: '2026-11-16T10:00:00+01:00', runner: { name: '@webtrax/cli', version: '0.1.0' },
      user_agent: 'WebtraxBot', spec: { spec_version: 1, job_id: 'j1', target: { start_url: 'https://example.com' } },
    }).success).toBe(true)
    expect(SummaryRecord.safeParse(summary).success).toBe(true)
    expect(SummaryRecord.safeParse({ ...summary, status: 'running' }).success).toBe(false)
    expect(SummaryRecord.safeParse({ ...summary, finished_at: 'yesterday' }).success).toBe(false)
  })

  it('RunLine picks the schema by type and rejects unknown types', () => {
    expect(RunLine.parse(finding).type).toBe('finding')
    expect(RunLine.parse(page).type).toBe('page')
    expect(RunLine.safeParse({ type: 'bogus' }).success).toBe(false)
  })

  it('RuleMeta', () => {
    expect(RuleMeta.safeParse({ id: 'links.broken.internal', suite: 'links', title: 'Broken internal link', version: 1, severity: 'high', why: 'w', fix: 'f', docs_slug: 'links-broken-internal' }).success).toBe(true)
    expect(RuleMeta.safeParse({ id: 'links.broken.internal', suite: 'links', title: 'x', version: 0, severity: 'high', why: 'w', fix: 'f', docs_slug: 'x' }).success).toBe(false)
  })

  it('orders severities for --fail-on', () => {
    expect(severityRank('critical')).toBeLessThan(severityRank('info'))
    expect(atLeast('high', 'medium')).toBe(true)
    expect(atLeast('low', 'medium')).toBe(false)
    expect(atLeast('medium', 'medium')).toBe(true)
  })
})
