// Engine behaviour against a scriptable local site: politeness, rate limits,
// slow pages, cancellation, the time budget, start-URL rules and limits.
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startRedirector } from '../../../fixtures/site/server.mjs'
import { crawl, HostThrottle, MemorySink } from '../src'

type Route = (req: http.IncomingMessage, res: http.ServerResponse, hits: number) => unknown
const routes = new Map<string, Route>()
const hits = new Map<string, number>()
const times = new Map<string, number[]>()
let origin: string
let server: http.Server

const html = (res: http.ServerResponse, body: string, status = 200) => {
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8' })
  res.end(`<!doctype html><html><head><title>t</title></head><body>${body}</body></html>`)
}
const links = (...hrefs: string[]) => hrefs.map((h) => `<a href="${h}">${h}</a>`).join('')
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

beforeAll(async () => {
  server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://x')
    const key = url.pathname
    hits.set(key, (hits.get(key) ?? 0) + 1)
    times.set(key, [...(times.get(key) ?? []), Date.now()])
    const route = routes.get(key)
    if (route) return route(req, res, hits.get(key)!)
    if (key === '/robots.txt' || key === '/sitemap.xml') { res.writeHead(404); return res.end() }
    html(res, 'not found', 404)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())))

const reset = () => { routes.clear(); hits.clear(); times.clear() }
const run = (over: Record<string, unknown> = {}, deps: Parameters<typeof crawl>[1] = {}) => {
  const sink = new MemorySink()
  const { limits, scope, ...rest } = over as { limits?: object; scope?: object }
  return crawl(
    { spec_version: 1, job_id: 't', target: { start_url: `${origin}/` }, scope: { allow_private: true, ...scope }, limits: { per_host_rps: 50, concurrency: 4, ...limits }, ...rest },
    { sink, throttle: new HostThrottle(), options: { retryDelayMs: 5, ...deps.options }, ...deps },
  ).then((r) => ({ ...r, sink }))
}

describe('start URL', () => {
  it('tells a watcher about each URL as it is answered, with the page that led to it', async () => {
    routes.set('/w', (_q, res) => html(res, links('/w/a', '/w/gone')))
    routes.set('/w/a', (_q, res) => html(res, links('/w/b', '/w')))
    routes.set('/w/b', (_q, res) => html(res, 'end'))
    const seen: { url: string; status: number | null; depth: number; total_ms: number | null; from: string | null }[] = []
    const r = await crawl({ spec_version: 1, job_id: 'w', target: { start_url: `${origin}/w` }, scope: { allow_private: true }, limits: { per_host_rps: 50 } },
      { sink: new MemorySink(), throttle: new HostThrottle(), onFetched: (f) => { seen.push(f); throw new Error('a watcher that throws') } })
    expect(r.summary.status).toBe('completed')
    expect(seen.map((f) => [f.url.replace(origin, ''), f.status, f.depth, f.from?.replace(origin, '') ?? null])).toEqual([['/w', 200, 0, null], ['/w/a', 200, 1, '/w'], ['/w/gone', 404, 1, '/w'], ['/w/b', 200, 2, '/w/a']])
    for (const f of seen) expect(f.total_ms).toBeGreaterThanOrEqual(0)
    expect(seen).toHaveLength(r.site!.pages.size)
  })

  it('fails the run when the start URL is unreachable (COR-02)', async () => {
    reset()
    routes.set('/', (_q, res) => html(res, 'down', 503))
    const { summary } = await run()
    expect(summary).toMatchObject({ status: 'failed', error: 'start_url_unreachable', start: { status: 503 } })
  })

  it('says why the start URL failed: its status, or the fetch error when nothing answered', async () => {
    reset()
    routes.set('/', (_q, res) => html(res, 'no', 403))
    expect((await run()).summary.start).toEqual({ status: 403 })
    // A port nothing listens on: no response at all.
    const closed = await crawl(
      { spec_version: 1, job_id: 't', target: { start_url: 'http://127.0.0.1:9/' }, scope: { allow_private: true }, limits: { per_host_rps: 50 } },
      { sink: new MemorySink(), throttle: new HostThrottle(), options: { retryDelayMs: 5 } },
    )
    expect(closed.summary).toMatchObject({ status: 'failed', error: 'start_url_unreachable', start: { status: null, error: 'connection_error' } })
    // A run that succeeds has no start record.
    reset()
    routes.set('/', (_q, res) => html(res, '<title>ok</title>'))
    expect((await run()).summary.start).toBeUndefined()
  })

  it('fails the run when the start URL redirects to another site', async () => {
    reset()
    routes.set('/', (_q, res) => { res.writeHead(302, { location: 'http://other.invalid/' }); res.end() })
    const { summary } = await run()
    expect(summary).toMatchObject({ status: 'failed', error: 'start_url_redirects_offsite' })
    expect(hits.get('/')).toBe(1)
  })

  it('adopts the final origin of a same-site redirect (COR-01)', async () => {
    reset()
    routes.set('/', (_q, res) => html(res, links('/a')))
    routes.set('/a', (_q, res) => html(res, ''))
    const redirector = await startRedirector(origin)
    try {
      const { summary, site } = await run({ target: { start_url: `${redirector.origin}/` } })
      expect(summary.status).toBe('completed')
      expect(site!.origin).toBe(origin)
      expect(site!.pages.has(`${origin}/a`)).toBe(true)
    } finally {
      await redirector.close()
    }
  })
})

describe('politeness', () => {
  it('honours robots.txt Crawl-delay for the WebtraxBot token, spacing requests to the host', async () => {
    reset()
    routes.set('/robots.txt', (_q, res) => { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('User-agent: WebtraxBot\nCrawl-delay: 1\n') })
    routes.set('/', (_q, res) => html(res, links('/a', '/b')))
    routes.set('/a', (_q, res) => html(res, ''))
    routes.set('/b', (_q, res) => html(res, ''))
    const started = Date.now()
    await run()
    const all = [...times.entries()].filter(([k]) => k !== '/' && k !== '/robots.txt').flatMap(([, t]) => t).sort()
    // Arrival times at the server: one request delivered late on a busy machine shortens the next gap
    // (CI saw 813 ms), so the floor is 700 ms; without Crawl-delay these go about 20 ms apart (50 rps).
    for (let i = 1; i < all.length; i++) expect(all[i]! - all[i - 1]!, `gap ${i}`).toBeGreaterThanOrEqual(700)
    // sitemap.xml, /a and /b go out after robots.txt sets the delay: two full gaps.
    expect(Date.now() - started).toBeGreaterThanOrEqual(1800)
  }, 15_000)

  it('waits out Retry-After on 429 and retries, and the page counts as fine', async () => {
    reset()
    routes.set('/', (_q, res) => html(res, links('/limited')))
    routes.set('/limited', (_q, res, n) => {
      if (n === 1) { res.writeHead(429, { 'retry-after': '1' }); return res.end() }
      html(res, 'ok')
    })
    const { site, summary } = await run()
    expect(hits.get('/limited')).toBe(2)
    expect(site!.links.get(`${origin}/limited`)).toMatchObject({ status: 200 })
    expect(summary.links.broken).toBe(0)
  }, 10_000)

  it('reports a host that stays rate limited as rate_limited, never as broken (COR-12)', async () => {
    reset()
    routes.set('/', (_q, res) => html(res, links('/always-limited')))
    routes.set('/always-limited', (_q, res) => { res.writeHead(429, { 'retry-after': '0' }); res.end() })
    const { site, summary } = await run()
    expect(site!.links.get(`${origin}/always-limited`)).toMatchObject({ error: 'rate_limited' })
    expect(summary.links.broken).toBe(0)
  })

  it('does not let one slow page hold up the others', async () => {
    reset()
    routes.set('/', (_q, res) => html(res, links('/slow', '/f1', '/f2', '/f3')))
    routes.set('/slow', async (_q, res) => { await sleep(1500); html(res, '') })
    for (const p of ['/f1', '/f2', '/f3']) routes.set(p, (_q, res) => html(res, ''))
    const { sink } = await run({ limits: { concurrency: 2 } })
    const order = sink.of('page').map((p) => new URL(p.url).pathname)
    expect(order.at(-1)).toBe('/slow')
    expect(order.indexOf('/f3')).toBeLessThan(order.indexOf('/slow'))
  })
})

describe('stopping early', () => {
  it('ends partial with stop_reason canceled when the caller aborts', async () => {
    reset()
    routes.set('/', (_q, res) => html(res, links(...Array.from({ length: 20 }, (_, i) => `/p${i}`))))
    for (let i = 0; i < 20; i++) routes.set(`/p${i}`, async (_q, res) => { await sleep(300); html(res, '') })
    const controller = new AbortController()
    setTimeout(() => controller.abort(), 400)
    const started = Date.now()
    const { summary } = await run({ limits: { concurrency: 2 } }, { signal: controller.signal })
    expect(summary).toMatchObject({ status: 'partial', stop_reason: 'canceled' })
    expect(Date.now() - started).toBeLessThan(2000)
    expect(summary.pages.crawled).toBeLessThan(21)
  })

  it('ends partial with stop_reason time_budget when the budget runs out', async () => {
    reset()
    routes.set('/', (_q, res) => html(res, links(...Array.from({ length: 20 }, (_, i) => `/p${i}`))))
    for (let i = 0; i < 20; i++) routes.set(`/p${i}`, async (_q, res) => { await sleep(200); html(res, '') })
    const { summary } = await run({ limits: { concurrency: 1 } }, { options: { timeBudgetMs: 500, drainMs: 1000 } })
    expect(summary).toMatchObject({ status: 'partial', stop_reason: 'time_budget' })
    expect(summary.pages.crawled).toBeGreaterThan(0)
    expect(summary.pages.crawled).toBeLessThan(21)
  })
})

describe('limits and scope', () => {
  it('stops queueing at max_pages and checks the rest as links, once each', async () => {
    reset()
    routes.set('/', (_q, res) => html(res, links('/a', '/b', '/c', '/d')))
    for (const p of ['/a', '/b', '/c', '/d']) routes.set(p, (_q, res) => html(res, links('/a', '/b', '/c', '/d')))
    const { site, summary } = await run({ limits: { max_pages: 3, concurrency: 1 } })
    expect(summary.pages.crawled).toBe(3)
    expect([...site!.links.values()].filter((l) => l.via === 'check').map((l) => new URL(l.url).pathname).sort()).toEqual(['/c', '/d'])
    for (const p of ['/a', '/b', '/c', '/d']) expect(hits.get(p), p).toBe(1)
  })

  it('respects max_depth', async () => {
    reset()
    routes.set('/', (_q, res) => html(res, links('/d1')))
    routes.set('/d1', (_q, res) => html(res, links('/d2')))
    routes.set('/d2', (_q, res) => html(res, links('/d3')))
    routes.set('/d3', (_q, res) => html(res, ''))
    const { site } = await run({ limits: { max_depth: 1 } })
    expect(site!.links.get(`${origin}/d1`)?.via).toBe('crawl')
    expect(site!.links.get(`${origin}/d2`)?.via).toBe('check')
    expect(hits.get('/d3')).toBeUndefined()
  })

  it('applies scope include and exclude to crawling', async () => {
    reset()
    routes.set('/', (_q, res) => html(res, links('/docs/a', '/blog/b', '/docs/private/c')))
    for (const p of ['/docs/a', '/blog/b', '/docs/private/c']) routes.set(p, (_q, res) => html(res, ''))
    const { site } = await run({ scope: { include: ['/', '/docs'], exclude: ['/docs/private'] } })
    expect(site!.links.get(`${origin}/docs/a`)?.via).toBe('crawl')
    expect(site!.links.get(`${origin}/docs/private/c`)?.via).toBe('check')
  })

  it('does not check external links when check_external is off', async () => {
    reset()
    routes.set('/', (_q, res) => html(res, links('http://example.invalid/x')))
    const { site } = await run({ scope: { check_external: false } })
    expect(site!.links.has('http://example.invalid/x')).toBe(false)
  })
})

describe('discovery', () => {
  it('follows a sitemap index and robots.txt Sitemap: lines', async () => {
    reset()
    routes.set('/robots.txt', (_q, res) => { res.writeHead(200); res.end(`Sitemap: ${origin}/extra.xml\n`) })
    routes.set('/sitemap.xml', (_q, res) => { res.writeHead(200); res.end(`<sitemapindex><sitemap><loc>${origin}/child.xml</loc></sitemap></sitemapindex>`) })
    routes.set('/child.xml', (_q, res) => { res.writeHead(200); res.end(`<urlset><url><loc>${origin}/from-index</loc></url></urlset>`) })
    routes.set('/extra.xml', (_q, res) => { res.writeHead(200); res.end(`<urlset><url><loc>${origin}/from-robots</loc></url></urlset>`) })
    routes.set('/', (_q, res) => html(res, ''))
    routes.set('/from-index', (_q, res) => html(res, ''))
    routes.set('/from-robots', (_q, res) => html(res, ''))
    const { site } = await run()
    expect(site!.pages.has(`${origin}/from-index`)).toBe(true)
    expect(site!.pages.has(`${origin}/from-robots`)).toBe(true)
  })

  it('resolves relative links against <base href>', async () => {
    reset()
    routes.set('/', (_q, res) => html(res, `<base href="/docs/">${links('page')}`))
    routes.set('/docs/page', (_q, res) => html(res, ''))
    const { site } = await run()
    expect(site!.links.get(`${origin}/docs/page`)?.status).toBe(200)
  })

  it('ignores mailto, tel, javascript and fragment-only links', async () => {
    reset()
    routes.set('/', (_q, res) => html(res, links('mailto:a@b.c', 'tel:1', 'javascript:void(0)', '#top', '/real#section')))
    routes.set('/real', (_q, res) => html(res, ''))
    const { site } = await run()
    expect([...site!.links.keys()].sort()).toEqual([`${origin}/`, `${origin}/real`])
  })
})

describe('auth headers (a protected preview)', () => {
  const port = () => new URL(origin).port
  const guardedSite = (seen: (string | undefined)[]) => {
    const gate: Route = (req, res) => {
      seen.push(req.headers['x-vercel-protection-bypass'] as string | undefined)
      if (req.headers['x-vercel-protection-bypass'] !== 'k3y') return html(res, 'protected', 401)
      return html(res, links('/a', `http://localhost:${port()}/ext`))
    }
    routes.set('/', gate)
    routes.set('/a', gate)
  }

  it('reaches a protected site with them, and sends them to no other host', async () => {
    reset()
    const seen: (string | undefined)[] = []
    const external: (string | undefined)[] = []
    guardedSite(seen)
    routes.set('/ext', (req, res) => { external.push(req.headers['x-vercel-protection-bypass'] as string | undefined); html(res, '') })
    const { summary, site } = await run({ auth: { headers: { 'X-Vercel-Protection-Bypass': 'k3y' } } })
    expect(summary.status).toBe('completed')
    expect([...site!.pages.values()].map((p) => p.status)).toEqual([200, 200])
    expect(seen.every((v) => v === 'k3y')).toBe(true)
    // The external link was checked, without the header.
    expect(external.length).toBeGreaterThan(0)
    expect(external.every((v) => v === undefined)).toBe(true)
  })

  it('without them, the protected site is unreachable', async () => {
    reset()
    guardedSite([])
    const { summary } = await run()
    expect(summary).toMatchObject({ status: 'failed', error: 'start_url_unreachable' })
  })

  it('refuses unresolved secret references and header injection', async () => {
    await expect(run({ auth: { headers: { 'x-a': { ref: 'vault:x' } } } })).rejects.toThrow(/resolved/)
    await expect(run({ auth: { headers: { 'x-a': 'v\r\nx-b: 1' } } })).rejects.toThrow(/invalid/)
  })
})
