// The rules fixture (C06.8; fixtures/site/rules.mjs): a page per rule the
// HTTP suites can find, and a clean twin that must give no findings.
//
// fixtures/expected/rules-findings.json and rules-score.json are the
// contract: every finding of every fixture run (rule, severity, URL, source,
// fingerprint) and the Health Score the CLI prints for the defect site. Any
// change in findings, fingerprints or score fails this test. Regenerate with
// UPDATE_GOLDEN=1 and review the diff in the commit. Webtrax Cloud computes
// the same score from the same findings (apps/app test/score-parity.test.ts).
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { crawl, HostThrottle, MemorySink, type CheckSuite, type CrawlResult } from '@webtrax/engine'
import { ScopePolicy } from '@webtrax/net-guard'
import { SCORE_VERSION, type FindingRecord, type JobSpecInput, type SuiteId } from '@webtrax/protocol'
import { buildReport } from '@webtrax/reporters'
import { a11ySuite } from '@webtrax/suite-a11y'
import { aiSuite } from '@webtrax/suite-ai'
import { contentSuite } from '@webtrax/suite-content'
import { linksSuite } from '@webtrax/suite-links'
import { performanceSuite } from '@webtrax/suite-performance'
import { securitySuite } from '@webtrax/suite-security'
import { seoSuite } from '@webtrax/suite-seo'
import { CLEAN_ALLOWED, DEFECTS, ELSEWHERE, FIXTURE_DICTIONARY, FIXTURE_LOOKUPS, FIXTURE_TODAY, startRulesSite, virtualFetch } from '../fixtures/site/rules.mjs'

const EXPECTED = join(import.meta.dirname, '..', 'fixtures', 'expected')
const FINDINGS_FILE = join(EXPECTED, 'rules-findings.json')
const SCORE_FILE = join(EXPECTED, 'rules-score.json')

const HTTP_SUITES: CheckSuite[] = [linksSuite, securitySuite, seoSuite, contentSuite, aiSuite]
const ALL_SUITES: CheckSuite[] = [...HTTP_SUITES, a11ySuite, performanceSuite]

/**
 * Rules this fixture does not produce, and why. Every other rule of every
 * suite must be found here; a rule that is found must not be listed. A new
 * rule fails this test until it has a defect page or a reason here.
 */
const NOT_HERE: Record<string, string> = {
  'links.not_checked': 'needs more link targets than maxLinkChecks (5,000); engine test behaviour.test.ts',
  // The browser-stage rules have their own fixture in real Chromium: test/browser-fixture.test.ts (fixtures/site/browser.mjs).
  'links.device.unreachable_on_phone': 'browser stage: test/browser-fixture.test.ts',
  'links.device.covered': 'browser stage: test/browser-fixture.test.ts',
  'ai_readiness.render.js_only': 'browser stage: test/browser-fixture.test.ts',
  'performance.*': 'browser stage: test/browser-fixture.test.ts (all four)',
  'a11y.*': 'browser stage: test/browser-fixture.test.ts has six of axe-core\'s rules; the rest are axe-core\'s own, tested there',
}
const notHere = (rule: string) => Object.keys(NOT_HERE).some((k) => k === rule || (k.endsWith('.*') && rule.startsWith(k.slice(0, -1))))

/** The fixture's runs: the defect site, two small sites for the start-page rules that exclude each other, and the clean twin. */
const RUNS: Record<string, { start: string; suites: SuiteId[] }> = {
  defects: { start: 'https://shop.example/', suites: ['links', 'security', 'seo', 'content', 'ai_readiness'] },
  plain: { start: 'http://plain.example/defects/security.https.missing', suites: ['links', 'security', 'ai_readiness'] },
  short: { start: 'https://short.example/old-home', suites: ['links', 'security', 'seo'] },
  clean: { start: 'https://clean.example/', suites: ['links', 'security', 'seo', 'content', 'ai_readiness'] },
}

let site: Awaited<ReturnType<typeof startRulesSite>>
const results: Record<string, { result: CrawlResult; sink: MemorySink }> = {}

async function run(name: string) {
  const r = RUNS[name]!
  const config: Partial<Record<SuiteId, Record<string, unknown>>> = { content: { dictionary: FIXTURE_DICTIONARY, today: FIXTURE_TODAY }, links: { device_sample: 500 } }
  const spec: JobSpecInput = {
    spec_version: 1, job_id: `rules-${name}`, target: { start_url: r.start }, scope: { allow_private: false },
    limits: { per_host_rps: 50, concurrency: 4, max_pages: 300 },
    suites: Object.fromEntries(r.suites.map((s) => [s, { enabled: true, config: config[s] ?? {} }])),
  }
  const sink = new MemorySink()
  const result = await crawl(spec, {
    sink, throttle: new HostThrottle(), suites: HTTP_SUITES, lookups: FIXTURE_LOOKUPS,
    fetch: virtualFetch(site.port, new ScopePolicy({ allowPrivate: false })) as never,
    options: { retryDelayMs: 5, requestTimeoutMs: 400, rateLimitAttempts: 2, traces: false, renderedLinks: false },
  })
  return { result, sink }
}

const line = (f: FindingRecord) => ({ rule_id: f.rule_id, severity: f.severity, url: f.url, ...(f.source_url ? { source_url: f.source_url } : {}), fingerprint: f.fingerprint })
const sorted = (fs: FindingRecord[]) => fs.map(line).sort((a, b) => `${a.rule_id} ${a.url} ${a.source_url ?? ''}`.localeCompare(`${b.rule_id} ${b.url} ${b.source_url ?? ''}`))
const path = (u: string | null | undefined) => (u?.startsWith('https://shop.example/') ? u.slice('https://shop.example'.length) : u)

beforeAll(async () => {
  site = await startRulesSite()
  for (const name of Object.keys(RUNS)) results[name] = await run(name)
}, 60_000)
afterAll(() => site.close())

describe('rules fixture', () => {
  it('every run completes with no suite errors', () => {
    for (const [name, { result }] of Object.entries(results)) {
      expect(result.summary.status, name).toBe('completed')
      expect(result.suiteErrors, name).toEqual([])
    }
  })

  it('findings and fingerprints match fixtures/expected/rules-findings.json', () => {
    const now = Object.fromEntries(Object.entries(results).map(([name, { result }]) => [name, sorted(result.findings)]))
    const text = `${JSON.stringify(now, null, 2)}\n`
    if (process.env.UPDATE_GOLDEN) writeFileSync(FINDINGS_FILE, text)
    expect(existsSync(FINDINGS_FILE), 'run with UPDATE_GOLDEN=1 to create it').toBe(true)
    expect(text).toBe(readFileSync(FINDINGS_FILE, 'utf8'))
  })

  it('the Health Score matches fixtures/expected/rules-score.json', () => {
    const now = Object.fromEntries(Object.entries(results).map(([name, { sink }]) => {
      const report = buildReport(sink.records, ALL_SUITES.flatMap((s) => s.rules))
      return [name, { version: SCORE_VERSION, score: report.score.score, grade: report.score.grade, pages: report.summary.pages.crawled, suites: report.summary.suites.map((s) => s.id), by_suite: Object.fromEntries(report.score.suites.map((s) => [s.suite, s.score])) }]
    }))
    const text = `${JSON.stringify(now, null, 2)}\n`
    if (process.env.UPDATE_GOLDEN) writeFileSync(SCORE_FILE, text)
    expect(existsSync(SCORE_FILE), 'run with UPDATE_GOLDEN=1 to create it').toBe(true)
    expect(text).toBe(readFileSync(SCORE_FILE, 'utf8'))
    expect(now.clean!.score).toBe(100)
    expect(now.defects!.score).toBeLessThan(80)
  })

  it('finds every rule of every suite, except those listed with a reason', () => {
    const found = new Set(Object.values(results).flatMap(({ result }) => result.findings.map((f) => f.rule_id)))
    const rules = ALL_SUITES.flatMap((s) => s.rules.map((r) => r.id))
    const missing = rules.filter((r) => !found.has(r) && !notHere(r))
    expect(missing, 'give these a defect page in fixtures/site/rules.mjs, or a reason in NOT_HERE').toEqual([])
    const listedButFound = [...found].filter((r) => notHere(r))
    expect(listedButFound, 'found by the fixture: take them out of NOT_HERE').toEqual([])
    // Every defect page is for a rule that exists.
    expect(Object.keys(DEFECTS).filter((r) => !rules.includes(r))).toEqual([])
  })

  it('reports each rule on its own defect page, or where ELSEWHERE expects it: no finding lands on another rule\'s page', () => {
    const out: string[] = []
    for (const [name, { result }] of Object.entries(results)) {
      if (name === 'clean') continue
      for (const f of result.findings) {
        const own = `/defects/${f.rule_id}`
        const at = [path(f.url), path(f.source_url)]
        const onOwnPage = at.some((p) => p === own || p?.startsWith(`${own}/`))
        const expected = ELSEWHERE[f.rule_id]?.some((e) => (e === null ? f.url === null : path(f.url) === e))
        if (!onOwnPage && !expected) out.push(`${name}: ${f.rule_id} at ${path(f.url) ?? 'site-wide'}${f.source_url ? ` from ${path(f.source_url)}` : ''}`)
      }
    }
    expect(out).toEqual([])
  })

  it('the clean twin gives no findings but the AI crawler summary', () => {
    const { result } = results.clean!
    expect(result.summary.pages.crawled).toBeGreaterThanOrEqual(7)
    expect(result.findings.filter((f) => !CLEAN_ALLOWED.includes(f.rule_id)).map((f) => `${f.rule_id} ${f.url}`)).toEqual([])
  })

  it('gives the same fingerprints on a second run', async () => {
    const again = await run('defects')
    const fps = (r: CrawlResult) => [...new Set(r.findings.map((f) => f.fingerprint))].sort()
    expect(fps(again.result)).toEqual(fps(results.defects!.result))
  })
})
