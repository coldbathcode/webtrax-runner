// Golden findings for the fixture site with every built suite enabled.
// fixtures/expected/findings.txt is the contract: one line per finding
// (rule, URL path, source path, evidence key), sorted. Regenerate with
// UPDATE_GOLDEN=1 and review the diff in the commit. Ports change per run,
// so the file holds paths; fingerprint stability is checked across runs.
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { crawl, HostThrottle, MemorySink, type CrawlResult } from '@webtrax/engine'
import { linksSuite } from '@webtrax/suite-links'
import { securitySuite } from '@webtrax/suite-security'
import { seoSuite } from '@webtrax/suite-seo'
import { startFixtureSite } from '../fixtures/site/server.mjs'

const EXPECTED_FILE = join(import.meta.dirname, '..', 'fixtures', 'expected', 'findings.txt')
const suites = [linksSuite, securitySuite, seoSuite]
let fixture: Awaited<ReturnType<typeof startFixtureSite>>

const run = async (): Promise<CrawlResult> =>
  crawl(
    {
      spec_version: 1, job_id: 'golden', target: { start_url: `${fixture.origin}/` }, scope: { allow_private: true },
      limits: { per_host_rps: 50, concurrency: 4 }, suites: { links: { enabled: true }, security: { enabled: true }, seo: { enabled: true } },
    },
    { sink: new MemorySink(), throttle: new HostThrottle(), suites, options: { retryDelayMs: 5 } },
  )

const describeFinding = (f: CrawlResult['findings'][number]) => {
  const p = (u: string | null | undefined) => (u ? u.replace(fixture.origin, '').replace(fixture.externalOrigin, 'EXT') || '/' : '-')
  return [f.rule_id, f.severity, p(f.url), '<-', p(f.source_url)].join(' ')
}

let first: CrawlResult
beforeAll(async () => {
  fixture = await startFixtureSite()
  first = await run()
})
afterAll(() => fixture.close())

describe('golden findings (fixture site, links + security + seo)', () => {
  it('match fixtures/expected/findings.txt', () => {
    const lines = [...new Set(first.findings.map(describeFinding))].sort()
    const text = `${lines.join('\n')}\n`
    if (process.env.UPDATE_GOLDEN) writeFileSync(EXPECTED_FILE, text)
    expect(existsSync(EXPECTED_FILE), 'run with UPDATE_GOLDEN=1 to create it').toBe(true)
    expect(text).toBe(readFileSync(EXPECTED_FILE, 'utf8'))
  })

  it('no suite failed', () => expect(first.suiteErrors).toEqual([]))

  it('produce identical fingerprints on every run', async () => {
    const fps = (r: CrawlResult) => [...new Set(r.findings.map((f) => f.fingerprint))].sort()
    const a = fps(first)
    expect(a.length).toBeGreaterThan(10)
    expect(fps(await run())).toEqual(a)
    expect(fps(await run())).toEqual(a)
  })

  it('count distinct findings by severity in the summary', () => {
    const bySeverity = { critical: 0, high: 0, medium: 0, low: 0, info: 0 }
    const seen = new Map(first.findings.map((f) => [f.fingerprint, f.severity]))
    for (const s of seen.values()) bySeverity[s] += 1
    expect(first.summary.findings).toEqual(bySeverity)
    expect(first.summary.suites.map((s) => s.id)).toEqual(['links', 'security', 'seo'])
  })
})
