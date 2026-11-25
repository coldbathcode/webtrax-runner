// Targeted checks and scan profiles in the engine (C06.8): with `target.urls`
// only those pages are fetched and their links checked, never crawled, and no
// sitemap is read; `rules` narrows what is reported; a suite configured
// `start_only` sees the start page alone.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startFixtureSite } from '../../../fixtures/site/server.mjs'
import { crawl, HostThrottle, MemorySink, type CheckSuite } from '../src'

let fixture: Awaited<ReturnType<typeof startFixtureSite>>
beforeAll(async () => { fixture = await startFixtureSite() })
afterAll(() => fixture.close())

const rule = (id: string) => ({ id, suite: 'seo' as const, title: id, version: 1, severity: 'low' as const, why: 'w', fix: 'f', docs_slug: id.replace(/\./g, '-'), tags: [] })
/** Reports every page it sees, twice: once as `seo.seen.page`, once as `seo.other.page`. */
const seeing: CheckSuite = {
  id: 'seo', version: '0.0.0', requires: ['http'], rules: [rule('seo.seen.page'), rule('seo.other.page')],
  async onPage(ctx, page) {
    await ctx.emit({ rule_id: 'seo.seen.page', url: page.url })
    await ctx.emit({ rule_id: 'seo.other.page', url: page.url })
  },
}
const path = (u: string) => new URL(u).pathname
const run = (extra: Record<string, unknown>, suiteConfig: Record<string, unknown> = {}) => {
  fixture.requests.length = 0
  return crawl({
    spec_version: 1, job_id: 't', target: { start_url: `${fixture.origin}/` }, scope: { allow_private: true }, limits: { per_host_rps: 50 },
    suites: { seo: { enabled: true, config: suiteConfig } }, ...extra,
  } as never, { sink: new MemorySink(), throttle: new HostThrottle(), suites: [seeing], options: { retryDelayMs: 5, linkRecords: false } })
}

describe('targeted checks', () => {
  it('fetches only the URLs named, checks their links without crawling them, and reads no sitemap', async () => {
    const r = await run({ target: { start_url: `${fixture.origin}/`, urls: [`${fixture.origin}/blog`, `${fixture.origin}/blog/post-2`] }, profile: 'targeted' })
    expect(r.summary.status).toBe('completed')
    expect(r.summary.pages.crawled).toBe(2)
    const seen = r.findings.filter((f) => f.rule_id === 'seo.seen.page').map((f) => path(f.url!)).sort()
    expect(seen).toEqual(['/blog', '/blog/post-2'])
    const got = new Set(fixture.requests.filter((q) => q.method === 'GET').map((q) => q.path))
    expect(got.has('/sitemap.xml')).toBe(false)
    expect(got.has('/orphan')).toBe(false)
    // /blog's links were checked (HEAD or GET), but not crawled as pages.
    const broken = [...r.site!.links.values()].filter((l) => l.status === 500 || l.status === 404).map((l) => path(l.url)).sort()
    expect(broken).toEqual(['/missing', '/server-error'])
    expect(r.site!.pages.has(`${fixture.origin}/blog/post-1`)).toBe(false)
  })

  it('crawls the start page too when it is one of the URLs', async () => {
    const r = await run({ target: { start_url: `${fixture.origin}/`, urls: [`${fixture.origin}/`] } })
    expect(r.findings.filter((f) => f.rule_id === 'seo.seen.page').map((f) => path(f.url!))).toEqual(['/'])
  })

  it('reports only the rules asked about, by id or prefix', async () => {
    const urls = [`${fixture.origin}/about`]
    const only = await run({ target: { start_url: `${fixture.origin}/`, urls }, rules: ['seo.seen.page'] })
    expect([...new Set(only.findings.map((f) => f.rule_id))]).toEqual(['seo.seen.page'])
    const prefix = await run({ target: { start_url: `${fixture.origin}/`, urls }, rules: ['seo.other'] })
    expect([...new Set(prefix.findings.map((f) => f.rule_id))]).toEqual(['seo.other.page'])
    const all = await run({ target: { start_url: `${fixture.origin}/`, urls } })
    expect(new Set(all.findings.map((f) => f.rule_id)).size).toBe(2)
  })
})

describe('start_only suites', () => {
  it('see the start page alone while the crawl goes on', async () => {
    const r = await run({}, { start_only: true })
    expect(r.summary.pages.crawled).toBeGreaterThan(3)
    expect(r.findings.filter((f) => f.rule_id === 'seo.seen.page').map((f) => path(f.url!))).toEqual(['/'])
  })
})
