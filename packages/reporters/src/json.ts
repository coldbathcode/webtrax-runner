/** JSON: one document for scripts and dashboards. NDJSON (the raw records) is what the run directory already holds. */
import { toNdjsonLine, type RunLine } from '@webtrax/protocol'
import type { Report } from './model'

export function renderJson(r: Report): string {
  return `${JSON.stringify({
    target: r.run.spec.target.start_url,
    job_id: r.run.job_id,
    runner: r.run.runner,
    summary: r.summary,
    findings: r.findings.map(({ rule, ...f }) => ({ ...f, ...(rule ? { why: rule.why, fix: rule.fix, docs: `https://webtrax.dev/docs/rules/${rule.docs_slug}` } : {}) })),
    pages: r.pages.map((p) => ({ url: p.url, final_url: p.final_url, status: p.status, ...(p.error ? { error: p.error } : {}), ...(p.title ? { title: p.title } : {}) })),
  }, null, 2)}\n`
}

export const renderNdjson = (records: readonly RunLine[]): string => records.map(toNdjsonLine).join('')
