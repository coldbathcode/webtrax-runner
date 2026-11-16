// A fixed run (as a crawl would write it) for golden reporter output.
import type { RuleMeta, RunLine } from '@webtrax/protocol'

const fp = (c: string) => c.repeat(64).slice(0, 64)
export const RULES: RuleMeta[] = [
  { id: 'links.broken.internal', suite: 'links', title: 'Broken internal link', version: 1, severity: 'high', why: 'Visitors reach an error page.', fix: 'Point the link at the page that exists now.', docs_slug: 'links-broken-internal', tags: [] },
  { id: 'security.header.csp_missing', suite: 'security', title: 'Content-Security-Policy missing', version: 1, severity: 'medium', why: 'A CSP limits injected scripts.', fix: 'Add a Content-Security-Policy.', docs_slug: 'security-header-csp-missing', tags: [] },
  { id: 'seo.lang.missing', suite: 'seo', title: 'Page does not declare its language', version: 1, severity: 'low', why: 'Screen readers need it.', fix: 'Add <html lang="en">.', docs_slug: 'seo-lang-missing', tags: [] },
]
export const RECORDS: RunLine[] = [
  { type: 'run', protocol_version: 1, job_id: 'sample', started_at: '2026-11-16T10:00:00.000Z', runner: { name: '@webtrax/cli', version: '0.1.0' }, user_agent: 'Mozilla/5.0 (compatible; WebtraxBot/1.0; +https://webtrax.dev/bot)',
    spec: { spec_version: 1, job_id: 'sample', target: { start_url: 'https://shop.example/' }, scope: { include: [], exclude: [], check_external: true, allow_private: false, respect_robots: true }, limits: { max_pages: 300, max_depth: 10, concurrency: 4, per_host_rps: 2, time_budget_s: 600 }, suites: { links: { enabled: true, config: {} } }, evidence: 'standard', labels: {} } },
  { type: 'page', url: 'https://shop.example/', final_url: 'https://shop.example/', status: 200, depth: 0, redirect_chain: [], title: 'Shop <home>' },
  { type: 'page', url: 'https://shop.example/old', final_url: 'https://shop.example/old', status: 404, depth: 1, redirect_chain: [] },
  { type: 'page', url: 'https://shop.example/down', final_url: 'https://shop.example/down', status: null, error: 'timeout', depth: 1, redirect_chain: [] },
  { type: 'finding', fingerprint: fp('a'), suite: 'links', rule_id: 'links.broken.internal', rule_version: 1, severity: 'high', url: 'https://shop.example/old', source_url: 'https://shop.example/', title: 'Broken internal link', evidence: { status: 404, link_text: 'Old <b>offer</b>' } },
  { type: 'finding', fingerprint: fp('a'), suite: 'links', rule_id: 'links.broken.internal', rule_version: 1, severity: 'high', url: 'https://shop.example/old', source_url: 'https://shop.example/blog', title: 'Broken internal link', evidence: { status: 404 } },
  { type: 'finding', fingerprint: fp('b'), suite: 'security', rule_id: 'security.header.csp_missing', rule_version: 1, severity: 'medium', url: 'https://shop.example/', title: 'Content-Security-Policy missing', evidence: {} },
  { type: 'finding', fingerprint: fp('c'), suite: 'seo', rule_id: 'seo.lang.missing', rule_version: 1, severity: 'low', url: 'https://shop.example/', title: 'Page does not declare its language', evidence: {} },
  { type: 'finding', fingerprint: fp('d'), suite: 'seo', rule_id: 'seo.unknown_rule', rule_version: 1, severity: 'info', url: null, title: 'A rule the reporter has no metadata for', evidence: { examples: ['javascript:alert(1)', 'https://x.example/'] } },
  { type: 'summary', job_id: 'sample', status: 'partial', stop_reason: 'time_budget', started_at: '2026-11-16T10:00:00.000Z', finished_at: '2026-11-16T10:01:05.500Z',
    pages: { crawled: 1, failed: 2 }, links: { checked: 12, broken: 1 }, findings: { critical: 0, high: 1, medium: 1, low: 1, info: 1 },
    suites: [{ id: 'links', version: '1.0.0', requires: ['http'] }, { id: 'security', version: '1.0.0', requires: ['http'] }, { id: 'seo', version: '1.0.0', requires: ['http'] }] },
]
