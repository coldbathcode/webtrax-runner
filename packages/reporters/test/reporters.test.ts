import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseNdjson } from '@webtrax/protocol'
import { buildReport, renderConsole, renderHtml, renderJson, renderMarkdown, renderNdjson } from '../src'
import { RECORDS, RULES } from './sample'

const report = buildReport(RECORDS, RULES)
const GOLDEN = join(import.meta.dirname, 'golden')
function golden(name: string, text: string) {
  const file = join(GOLDEN, name)
  if (process.env.UPDATE_GOLDEN) { mkdirSync(GOLDEN, { recursive: true }); writeFileSync(file, text) }
  expect(existsSync(file), `missing ${name}: run with UPDATE_GOLDEN=1`).toBe(true)
  expect(text).toBe(readFileSync(file, 'utf8'))
}

describe('report model', () => {
  it('groups findings by fingerprint with every source page, most severe first', () => {
    expect(report.findings.map((f) => [f.severity, f.rule_id, f.sources.length])).toEqual([
      ['high', 'links.broken.internal', 2], ['medium', 'security.header.csp_missing', 0], ['low', 'seo.lang.missing', 0], ['info', 'seo.unknown_rule', 0],
    ])
    expect(report.findings[0]!.id).toBe('aaaaaaaaaa')
    expect(report.counts).toEqual(RECORDS.find((r) => r.type === 'summary')!.findings)
  })
  it('needs a run and a summary', () => expect(() => buildReport(RECORDS.slice(1))).toThrow(/run record/))
})

describe('golden output', () => {
  it('console (plain)', () => golden('console.txt', renderConsole(report, { reportPath: '.webtrax/runs/x/report.html' })))
  it('console (colour) only adds escape codes', () => {
    const colour = renderConsole(report, { color: true })
    expect(colour).toContain('\x1b[31m')
    // eslint-disable-next-line no-control-regex
    expect(colour.replace(/\x1b\[[0-9;]*m/g, '')).toBe(renderConsole(report))
  })
  it('markdown', () => golden('report.md', renderMarkdown(report)))
  it('json', () => golden('report.json', renderJson(report)))
  it('html', () => golden('report.html', renderHtml(report)))
})

describe('safety and limits', () => {
  it('escapes everything from the crawled site in HTML, and links only http(s)', () => {
    const html = renderHtml(report)
    expect(html).not.toContain('<b>offer</b>')
    expect(html).toContain('Old &lt;b&gt;offer&lt;/b&gt;')
    expect(html).toContain('Shop &lt;home&gt;')
    expect(html).not.toMatch(/href="javascript:/i)
    expect(html).toContain('<a href="https://x.example/">')
    expect(html).not.toMatch(/<script|<link rel="stylesheet"|https:\/\/fonts\./)
  })
  it('escapes Markdown control characters in titles and evidence', () => {
    expect(renderMarkdown(report)).toContain('Old \\<b\\>offer\\</b\\>')
  })
  it('caps long lists', () => {
    expect(renderConsole(report, { max: 2 })).toContain('… and 2 more')
    expect(renderMarkdown(report, { maxPerSeverity: 0 })).toContain('- … and 1 more')
  })
  it('round-trips the raw records as NDJSON', () => {
    expect(parseNdjson(renderNdjson(RECORDS)).every((l) => l.ok)).toBe(true)
  })
})

describe('what a run could not vouch for', () => {
  it('names checks that did not run or ran with errors, and a crawl that stopped at its own limit', async () => {
    const { caveatText } = await import('../src/model')
    const base = report.summary
    expect(caveatText({ ...base, status: 'completed', stop_reason: undefined, suites: [{ id: 'links', version: '1', requires: ['http'] }] })).toBeNull()
    expect(caveatText({ ...base, stop_reason: 'page_limit', suites: [
      { id: 'links', version: '1', requires: ['http'] }, { id: 'a11y', version: '1', requires: ['http', 'browser'], complete: false, skipped: true }, { id: 'seo', version: '1', requires: ['http'], complete: false },
    ] })).toBe('Did not run: a11y. Ran with errors, so may have missed issues: seo. The site has more pages than this run may crawl: the rest were not checked.')
  })
})
