// The browser fixture (fixtures/site/browser.mjs): every browser-stage rule
// on a page of its own, loaded in real Chromium, and clean twins that give
// none. fixtures/expected/browser-findings.json is the contract: each
// finding's rule, path and severity (not a performance finding's severity,
// which follows how fast the machine is within the rule's band, and not
// fingerprints, which carry the local server's port). Regenerate with
// UPDATE_GOLDEN=1 and review the diff in the commit.
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { crawl, HostThrottle, MemorySink, type BrowserProfileId, type CheckSuite, type CrawlResult } from '@webtrax/engine'
import type { SuiteId } from '@webtrax/protocol'
import { a11ySuite } from '@webtrax/suite-a11y'
import { aiSuite } from '@webtrax/suite-ai'
import { linksSuite } from '@webtrax/suite-links'
import { performanceSuite } from '@webtrax/suite-performance'
import { MEASURE_DEFECTS, startBrowserSite } from '../fixtures/site/browser.mjs'

const FILE = join(import.meta.dirname, '..', 'fixtures', 'expected', 'browser-findings.json')

/** The rules only the browser stage finds: what this fixture is for. */
const BROWSER_RULES = (id: string) => id.startsWith('a11y.') || id.startsWith('performance.') || id === 'ai_readiness.render.js_only' || id === 'links.device.unreachable_on_phone' || id === 'links.device.covered'
/** Every one of these must be found; for a11y, the fixture's sample of axe's rules. */
const MUST_FIND = [...Object.keys(MEASURE_DEFECTS), 'links.device.unreachable_on_phone', 'links.device.covered', 'performance.engine.weight_differs']

// The device runs need a browser suite to start the stage; a phone loading the speed pages would fire every speed
// rule on its slow line, so they load pages with a suite that measures nothing.
const loader: CheckSuite = { id: 'performance', version: '0.0.0', requires: ['browser'], rules: [], everyProfile: true, async onBrowserPage() {} }

type Site = Awaited<ReturnType<typeof startBrowserSite>>
const sites: Record<string, Site> = {}
const results: Record<string, CrawlResult> = {}

async function run(name: string, origin: string, suites: CheckSuite[], profiles: BrowserProfileId[]) {
  const ids = [...new Set(suites.map((s) => s.id))] as SuiteId[]
  return crawl(
    {
      spec_version: 1, job_id: `browser-${name}`, target: { start_url: `${origin}/` }, scope: { allow_private: true },
      limits: { per_host_rps: 50, concurrency: 4, max_pages: 50 }, browser: { profiles },
      suites: Object.fromEntries(ids.map((s) => [s, { enabled: true, config: { sample: 50 } }])),
    },
    { sink: new MemorySink(), throttle: new HostThrottle(), suites, options: { retryDelayMs: 5, traces: false, renderedLinks: name.startsWith('device') } },
  )
}

const path = (origin: string, u: string | null | undefined) => (u?.startsWith(origin) ? u.slice(origin.length) : u ?? null)
const lines = (name: string) => {
  const origin = sites[name]!.origin
  return results[name]!.findings.filter((f) => BROWSER_RULES(f.rule_id))
    .map((f) => ({ rule_id: f.rule_id, path: path(origin, f.url), ...(f.source_url ? { source: path(origin, f.source_url) } : {}), ...(f.rule_id.startsWith('performance.') ? {} : { severity: f.severity }) }))
    .sort((a, b) => `${a.rule_id} ${a.path}`.localeCompare(`${b.rule_id} ${b.path}`))
}

beforeAll(async () => {
  for (const [name, kind, clean] of [['measure', 'measure', false], ['measure-clean', 'measure', true], ['device', 'device', false], ['device-clean', 'device', true], ['engines', 'engines', false], ['engines-clean', 'engines', true]] as const) sites[name] = await startBrowserSite(kind, { clean })
  const measureSuites = [a11ySuite, performanceSuite, aiSuite]
  const deviceSuites = [linksSuite, loader]
  // In parallel: the speed pages are slow on purpose.
  const [m, mc, d, dc, e, ec] = await Promise.all([
    run('measure', sites.measure!.origin, measureSuites, ['desktop']),
    run('measure-clean', sites['measure-clean']!.origin, measureSuites, ['desktop']),
    run('device', sites.device!.origin, deviceSuites, ['desktop', 'phone']),
    run('device-clean', sites['device-clean']!.origin, deviceSuites, ['desktop', 'phone']),
    run('engines', sites.engines!.origin, [performanceSuite], ['desktop', 'firefox-desktop']),
    run('engines-clean', sites['engines-clean']!.origin, [performanceSuite], ['desktop', 'firefox-desktop']),
  ])
  Object.assign(results, { measure: m, 'measure-clean': mc, device: d, 'device-clean': dc, engines: e, 'engines-clean': ec })
}, 240_000)
afterAll(async () => { for (const s of Object.values(sites)) await s.close() })

describe('browser fixture', () => {
  it('every run completes with no suite errors, and the browser loaded every page', () => {
    for (const [name, r] of Object.entries(results)) {
      expect(r.summary.status, name).toBe('completed')
      expect(r.suiteErrors, name).toEqual([])
      expect(r.site!.browser!.pages, name).toBeGreaterThanOrEqual(r.summary.pages.crawled)
    }
  })

  it('finds every browser-stage rule it has a page for', () => {
    const found = new Set([...lines('measure'), ...lines('device'), ...lines('engines')].map((l) => l.rule_id))
    expect(MUST_FIND.filter((r) => !found.has(r))).toEqual([])
    // Every performance rule there is, and the rest of the browser-only rules, have a page here.
    for (const r of performanceSuite.rules) expect(MUST_FIND).toContain(r.id)
  })

  it('reports each rule on its own page: no finding lands on another rule\'s page', () => {
    const astray = ['measure', 'device', 'engines'].flatMap((name) => lines(name)
      .filter((l) => ![l.path, l.source ?? null].some((p) => p === `/defects/${l.rule_id}`))
      .map((l) => `${name}: ${l.rule_id} at ${l.path}`))
    expect(astray).toEqual([])
  })

  it('the clean twins give no browser-stage findings', () => {
    expect(lines('measure-clean')).toEqual([])
    expect(lines('device-clean')).toEqual([])
    expect(lines('engines-clean')).toEqual([])
  })

  it('findings match fixtures/expected/browser-findings.json', () => {
    const now = { measure: lines('measure'), device: lines('device'), engines: lines('engines') }
    const text = `${JSON.stringify(now, null, 2)}\n`
    if (process.env.UPDATE_GOLDEN) writeFileSync(FILE, text)
    expect(existsSync(FILE), 'run with UPDATE_GOLDEN=1 to create it').toBe(true)
    expect(text).toBe(readFileSync(FILE, 'utf8'))
  })
})
