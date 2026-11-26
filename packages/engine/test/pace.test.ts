// Going as fast as a site answers well, and stopping when it says no
// (limits.origin_max_rps; throttle.ts, classify.ts botWall). The site itself
// speeds up while its answers stay quick, backs off on 429s and slow answers,
// and a firewall or bot challenge is paused for, then left alone: never got
// around. Other hosts keep per_host_rps.
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { botWall, crawl, HostThrottle, IDLE_FORGET_MS, isBrokenOutcome, MemorySink, MIN_ADAPTIVE_RPS, WALL_LIMIT, type ThrottleClock } from '../src'

function fakeClock(start = 0) {
  let t = start
  const clock: ThrottleClock = { now: () => t, sleep: async (ms) => { t += ms } }
  return { clock, advance: (ms: number) => { t += ms }, get now() { return t } }
}

describe('an adaptive host (the scan\'s own site)', () => {
  it('starts at its base, grows by half each good round until trouble, and never passes its maximum', () => {
    const f = fakeClock()
    const t = new HostThrottle(f.clock)
    t.adaptive('a.test', 2, 20)
    expect(t.intervalMs('a.test', 2)).toBe(500)
    const rates: number[] = []
    for (let i = 0; i < 200; i++) {
      t.observe('a.test', 50)
      rates.push(t.rate('a.test')!)
    }
    expect(rates[1]).toBe(3)
    expect(rates.at(-1)).toBe(20)
    expect(t.peakRate('a.test')).toBe(20)
    expect(t.intervalMs('a.test', 2)).toBe(50)
    // Another host is untouched.
    expect(t.intervalMs('b.test', 2)).toBe(500)
    expect(t.rate('b.test')).toBeNull()
  })

  it('halves on a 429, holds for 30 s, then grows one at a time', () => {
    const f = fakeClock()
    const t = new HostThrottle(f.clock)
    t.adaptive('a.test', 8, 20)
    t.penalise('a.test')
    expect(t.rate('a.test')).toBe(4)
    for (let i = 0; i < 50; i++) t.observe('a.test', 50)
    expect(t.rate('a.test')).toBe(4)
    f.advance(30_000)
    for (let i = 0; i < 4; i++) t.observe('a.test', 50)
    expect(t.rate('a.test')).toBe(5)
  })

  it('stops growing when answers slow against its own best, and gives a quarter back when they slow badly', () => {
    const f = fakeClock()
    const t = new HostThrottle(f.clock)
    t.adaptive('a.test', 4, 20)
    for (let i = 0; i < 8; i++) t.observe('a.test', 100)
    // Answers settle at six times the best: no more growth, however long it lasts.
    for (let i = 0; i < 30; i++) t.observe('a.test', 600)
    const before = t.rate('a.test')!
    for (let i = 0; i < 100; i++) t.observe('a.test', 600)
    expect(t.rate('a.test')).toBe(before)
    for (let i = 0; i < 20; i++) t.observe('a.test', 3000)
    expect(t.rate('a.test')).toBeLessThan(before)
    expect(t.rate('a.test')).toBeGreaterThanOrEqual(MIN_ADAPTIVE_RPS)
  })

  it('still honours Crawl-delay', () => {
    const t = new HostThrottle(fakeClock().clock)
    t.adaptive('a.test', 2, 20)
    t.setCrawlDelay('a.test', 3)
    for (let i = 0; i < 100; i++) t.observe('a.test', 20)
    expect(t.intervalMs('a.test', 2)).toBe(3000)
  })
})

describe('walls and forgetting', () => {
  it('pauses on a wall, longer each time, and stops at the third', async () => {
    const f = fakeClock()
    const t = new HostThrottle(f.clock)
    t.adaptive('a.test', 2, 20)
    expect(t.wall('a.test')).toBe('pause')
    expect(t.rate('a.test')).toBe(MIN_ADAPTIVE_RPS)
    await t.wait('a.test', 2)
    expect(f.now).toBe(15_000)
    expect(t.wall('a.test')).toBe('pause')
    await t.wait('a.test', 2)
    expect(f.now).toBe(15_000 + 30_000)
    expect(t.walled('a.test')).toBe(false)
    expect(t.wall('a.test')).toBe('stop')
    expect(t.walled('a.test')).toBe(true)
    expect(WALL_LIMIT).toBe(3)
  })

  it('lets a fixed host\'s 429 penalty fade a minute at a time (V2-COR-12)', () => {
    const f = fakeClock()
    const t = new HostThrottle(f.clock)
    for (let i = 0; i < 3; i++) t.penalise('a.test')
    expect(t.intervalMs('a.test', 2)).toBe(4000)
    f.advance(60_000)
    expect(t.intervalMs('a.test', 2)).toBe(2000)
    f.advance(120_000)
    expect(t.intervalMs('a.test', 2)).toBe(500)
  })

  it('forgets a host after ten idle minutes: walls, penalties and Crawl-delay', async () => {
    const f = fakeClock()
    const t = new HostThrottle(f.clock)
    t.setCrawlDelay('a.test', 10)
    for (let i = 0; i < WALL_LIMIT; i++) t.wall('a.test')
    await t.wait('a.test', 2)
    expect(t.walled('a.test')).toBe(true)
    f.advance(IDLE_FORGET_MS + 60_000)
    expect(t.walled('a.test')).toBe(false)
    expect(t.intervalMs('a.test', 2)).toBe(500)
  })
})

describe('botWall', () => {
  it('names vendors from the signals they document, and nothing else', () => {
    expect(botWall(403, { 'cf-mitigated': 'challenge', server: 'cloudflare' })).toBe('Cloudflare')
    expect(botWall(429, { 'x-vercel-mitigated': 'challenge' })).toBe('Vercel')
    expect(botWall(202, { 'x-amzn-waf-action': 'challenge' })).toBe('AWS WAF')
    expect(botWall(403, { 'x-datadome': 'protected' })).toBe('DataDome')
    expect(botWall(403, { server: 'AkamaiGHost' })).toBe('Akamai')
    expect(botWall(403, { 'x-sucuri-block': '1' })).toBe('Sucuri')
    // A site's own 403 through a proxy that stamps every answer is not a wall.
    expect(botWall(403, { server: 'cloudflare', 'cf-ray': 'abc' })).toBeNull()
    expect(botWall(200, { server: 'AkamaiGHost' })).toBeNull()
    expect(botWall(200, { 'x-datadome': 'protected' })).toBeNull()
    expect(botWall(404, {})).toBeNull()
    expect(botWall(null, { 'cf-mitigated': 'challenge' })).toBeNull()
  })
})

// Crawls of local sites. Time is a fake clock (sleeps pass at once), so pauses cost nothing here.
const page = (title: string, body: string) => `<!doctype html><html lang="en"><title>${title}</title><body><h1>${title}</h1>${body}</body></html>`
type Handler = (req: http.IncomingMessage, res: http.ServerResponse, hits: number) => void
async function serve(handler: Handler) {
  const log: string[] = []
  const server = http.createServer((req, res) => {
    log.push(`${req.method} ${req.url}`)
    handler(req, res, log.length)
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  return { origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, log, close: () => new Promise<void>((r) => server.close(() => r())) }
}
const html = (res: http.ServerResponse, status: number, body: string, headers: Record<string, string> = {}) => { res.writeHead(status, { 'content-type': 'text/html', ...headers }); res.end(body) }
/** Forty pages, each linking to the next ones and, optionally, to an outside host. */
const pages = (outside?: string): Handler => (req, res) => {
  const n = Number(/^\/p\/(\d+)$/.exec(req.url ?? '')?.[1] ?? (req.url === '/' ? 0 : NaN))
  if (!Number.isFinite(n) || n > 40) return html(res, 404, page('Not found', ''))
  const links = [n + 1, n + 2].filter((i) => i <= 40).map((i) => `<a href="/p/${i}">${i}</a>`).join(' ')
  html(res, 200, page(`Page ${n}`, `${links}${outside ? ` <a href="${outside}/doc/${n}">doc</a>` : ''}`))
}

let f: ReturnType<typeof fakeClock>
beforeEach(() => { f = fakeClock(Date.now()) })
const spec = (origin: string, limits: Record<string, number> = {}) =>
  ({ spec_version: 1 as const, job_id: 'pace', target: { start_url: `${origin}/` }, scope: { allow_private: true, respect_robots: false }, limits: { per_host_rps: 2, concurrency: 4, max_depth: 50, ...limits }, suites: { links: { enabled: true } } })
const deps = () => ({ sink: new MemorySink(), throttle: new HostThrottle(f.clock), clock: f.clock, options: { retryDelayMs: 1 } })

describe('crawling at the site\'s own pace', () => {
  let site: Awaited<ReturnType<typeof serve>>
  beforeAll(async () => { site = await serve(pages()) })
  afterAll(() => site.close())

  it('speeds the site up past per_host_rps and says how fast it went', async () => {
    const started = f.now
    const r = await crawl(spec(site.origin, { origin_max_rps: 20 }), deps())
    expect(r.summary).toMatchObject({ status: 'completed', pages: { crawled: 41 } })
    expect(r.summary.origin_rps).toBeGreaterThan(8)
    expect(r.summary.walls).toBeUndefined()
    const fast = f.now - started
    f = fakeClock(Date.now())
    const slowStart = f.now
    const slow = await crawl(spec(site.origin), deps())
    expect(slow.summary.origin_rps).toBeUndefined()
    // At 2 a second, 41 pages wait at least 20 s (of fake time); at the site's own pace, a fraction of that.
    expect(f.now - slowStart).toBeGreaterThanOrEqual(20_000)
    expect(fast).toBeLessThan((f.now - slowStart) / 3)
  })
})

describe('a site that rate-limits', () => {
  let site: Awaited<ReturnType<typeof serve>>
  let limited = 0
  beforeAll(async () => {
    const inner = pages()
    // Every fifth request is refused with a 429, as a busy origin would.
    site = await serve((req, res, hits) => {
      if (hits > 1 && hits % 5 === 0) { limited += 1; res.writeHead(429, { 'retry-after': '1' }); return res.end() }
      inner(req, res, hits)
    })
  })
  afterAll(() => site.close())

  it('backs off and still checks every page, calling nothing broken', async () => {
    const r = await crawl(spec(site.origin, { origin_max_rps: 20 }), deps())
    expect(limited).toBeGreaterThan(0)
    expect(r.summary).toMatchObject({ status: 'completed', pages: { crawled: 41, failed: 0 }, links: { broken: 0 } })
    expect(r.summary.origin_rps).toBeLessThan(20)
  })
})

describe('a site whose firewall walls the scanner', () => {
  let site: Awaited<ReturnType<typeof serve>>
  beforeAll(async () => {
    const inner = pages()
    // After ten requests, the edge answers every one with a challenge.
    site = await serve((req, res, hits) => hits > 10 ? html(res, 403, page('Just a moment...', ''), { 'cf-mitigated': 'challenge', server: 'cloudflare' }) : inner(req, res, hits))
  })
  afterAll(() => site.close())

  it('pauses, tries once more, then stops: partial, blocked, and nothing more is asked of it', async () => {
    const r = await crawl(spec(site.origin, { origin_max_rps: 20 }), deps())
    expect(r.summary).toMatchObject({ status: 'partial', stop_reason: 'blocked', links: { broken: 0 } })
    expect(r.summary.walls).toEqual([expect.objectContaining({ host: new URL(site.origin).host, by: 'Cloudflare', origin: true })])
    // Ten pages, then walls until the third: a few more where requests were already in flight (concurrency 4), and then nothing.
    expect(r.summary.walls![0]!.walls).toBeGreaterThanOrEqual(WALL_LIMIT)
    expect(site.log.length).toBeLessThanOrEqual(10 + WALL_LIMIT + 4)
    // The pages the wall answered are recorded as not verified, and none counts as broken.
    const walled = [...r.site!.pages.values()].filter((p) => p.error === 'rate_limited')
    expect(walled.length).toBeGreaterThan(0)
    expect(walled.every((p) => !isBrokenOutcome(p))).toBe(true)
    // And none of them counts as reached, so no issue on them can be marked fixed.
    const reached = new Set(r.reached.all)
    expect(walled.filter((p) => reached.has(p.url))).toEqual([])
    expect(reached.size).toBeGreaterThan(0)
  })
})

describe('an outside host that walls', () => {
  let site: Awaited<ReturnType<typeof serve>>
  let docs: Awaited<ReturnType<typeof serve>>
  beforeAll(async () => {
    docs = await serve((_req, res) => html(res, 403, page('Access denied', ''), { server: 'AkamaiGHost' }))
    site = await serve(pages('http://placeholder'))
    // Point the site's outside links at the docs host now that it has a port.
    await site.close()
    site = await serve(pages(docs.origin))
  })
  afterAll(async () => { await site.close(); await docs.close() })

  it('checks the site in full and reports the host\'s links as unverified, not broken', async () => {
    const r = await crawl(spec(site.origin, { origin_max_rps: 20 }), deps())
    expect(r.summary).toMatchObject({ status: 'completed', pages: { crawled: 41 }, links: { broken: 0 } })
    const wall = r.summary.walls?.find((w) => !w.origin)
    expect(wall).toMatchObject({ host: new URL(docs.origin).host, by: 'Akamai' })
    expect(wall!.walls).toBeGreaterThanOrEqual(WALL_LIMIT)
    expect(wall!.skipped).toBeGreaterThan(25)
    // Walls until the third, a few more already in flight (link checks run 8 at a time), and then nothing.
    expect(docs.log.length).toBeLessThanOrEqual(WALL_LIMIT + 8)
  })
})
