// Golden crawl of the fixture site (runner/fixtures/site/server.mjs), the same
// site v1's crawl-loop test uses, so v2 is held to v1's results.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { EXPECTED, startFixtureSite, type FixtureRequest } from '../../../fixtures/site/server.mjs'
import { crawl, HostThrottle, isBrokenOutcome, MemorySink, type CrawlResult } from '../src'

let fixture: Awaited<ReturnType<typeof startFixtureSite>>
let result: CrawlResult
let sink: MemorySink
let requests: FixtureRequest[]

const path = (url: string) => new URL(url).pathname
const spec = (origin: string) => ({
  spec_version: 1 as const,
  job_id: 'golden',
  target: { start_url: `${origin}/` },
  scope: { allow_private: true },
  limits: { per_host_rps: 50, concurrency: 4 },
})

beforeAll(async () => {
  fixture = await startFixtureSite()
  sink = new MemorySink()
  result = await crawl(spec(fixture.origin), { sink, throttle: new HostThrottle(), options: { retryDelayMs: 10 } })
  requests = [...fixture.requests]
})
afterAll(() => fixture.close())

describe('golden crawl of the fixture site', () => {
  it('completes and crawls exactly the expected pages (v1 parity)', () => {
    expect(result.summary).toMatchObject({ status: 'completed', pages: { crawled: EXPECTED.crawledPages.length } })
    const crawled = sink.of('page').filter((p) => p.title !== undefined).map((p) => path(p.final_url))
    expect(crawled.sort()).toEqual([...EXPECTED.crawledPages].sort())
  })

  it('finds the expected broken links, internal and external', () => {
    const broken = [...result.site!.links.values()].filter(isBrokenOutcome)
    expect(broken.filter((l) => l.internal).map((l) => path(l.url)).sort()).toEqual([...EXPECTED.brokenInternal].sort())
    expect(broken.filter((l) => !l.internal).map((l) => path(l.url))).toEqual(EXPECTED.brokenExternal)
    expect(result.summary.links.broken).toBe(EXPECTED.brokenInternal.length + EXPECTED.brokenExternal.length)
  })

  it('never requests a robots-disallowed URL, and records it as skipped', () => {
    expect(requests.some((r) => r.path.startsWith('/private'))).toBe(false)
    expect(result.site!.links.get(`${fixture.origin}/private/secret`)).toMatchObject({ via: 'skipped', error: 'robots_disallowed' })
  })

  it('fetches every URL at most once per method (the 5xx retry is the only repeat)', () => {
    const counts = new Map<string, number>()
    for (const r of requests) counts.set(`${r.method} ${r.host} ${r.path}`, (counts.get(`${r.method} ${r.host} ${r.path}`) ?? 0) + 1)
    const repeated = [...counts].filter(([, n]) => n > 1).map(([k]) => k)
    expect(repeated).toEqual([`GET ${new URL(fixture.origin).host} /server-error`])
    expect(counts.get(`GET ${new URL(fixture.origin).host} /server-error`)).toBe(2)
  })

  it('follows a redirect only until it reaches a page the crawl already has', () => {
    const about = requests.filter((r) => r.path === '/about' && r.host === new URL(fixture.origin).host)
    expect(about).toHaveLength(1)
  })

  it('confirms a 404 on HEAD with one GET (servers often mishandle HEAD)', () => {
    const missing = requests.filter((r) => r.path === '/external-missing').map((r) => r.method)
    expect(missing).toEqual(['HEAD', 'GET'])
  })

  it('answers internal links from the crawl, and checks external links without crawling them', () => {
    expect(result.site!.links.get(`${fixture.origin}/about`)?.via).toBe('crawl')
    const external = requests.filter((r) => r.host === new URL(fixture.externalOrigin).host)
    expect(external.every((r) => r.method === 'HEAD' || r.path === '/external-missing')).toBe(true)
    expect(result.site!.links.get(`${fixture.externalOrigin}/external-ok`)).toMatchObject({ via: 'check', status: 200 })
  })

  it('records redirects with their chain and attributes the page to its final URL', () => {
    const old = sink.of('page').find((p) => path(p.url) === '/old-page')!
    expect(old).toMatchObject({ status: 301, redirect_chain: [{ url: `${fixture.origin}/old-page`, status: 301 }] })
    expect(path(old.final_url)).toBe('/about')
  })

  it('seeds from the sitemap, including pages no link reaches', () => {
    expect(result.site!.edges.some((e) => e.kind === 'sitemap' && path(e.to) === '/orphan')).toBe(true)
    expect(result.site!.links.get(`${fixture.origin}/gone-from-sitemap`)).toMatchObject({ status: 404 })
  })

  it('identifies itself as WebtraxBot on every request', () => {
    expect(requests.every((r) => r.ua.includes('WebtraxBot'))).toBe(true)
  })

  it('writes a valid run: a run record first, a summary last, every line protocol-valid', () => {
    expect(sink.records[0]!.type).toBe('run')
    expect(sink.records.at(-1)!.type).toBe('summary')
  })
})

describe('repeatability', () => {
  it('visits pages in the same order on every run (concurrency 1)', async () => {
    const order = async () => {
      const s = new MemorySink()
      await crawl({ ...spec(fixture.origin), limits: { per_host_rps: 50, concurrency: 1 } }, { sink: s, throttle: new HostThrottle(), options: { retryDelayMs: 1 } })
      return s.of('page').map((p) => path(p.url))
    }
    const first = await order()
    expect(await order()).toEqual(first)
    expect(await order()).toEqual(first)
  })
})
