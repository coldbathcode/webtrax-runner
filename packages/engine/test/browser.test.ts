// The browser stage: one Chromium load per selected page, through the egress
// proxy, handed to browser suites; metrics; and refusals recorded.
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { RuleMeta } from '@webtrax/protocol'
import { crawl, HostThrottle, MemorySink, type CheckSuite } from '../src'

let origin: string
let server: http.Server
beforeAll(async () => {
  server = http.createServer((req, res) => {
    const page = (title: string, body: string) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end(`<!doctype html><html lang="en"><title>${title}</title><body>${body}</body></html>`) }
    if (req.url === '/') return page('Home', '<a href="/b">b</a><a href="/a">a</a><a href="/c">c</a><img src="http://169.254.169.254/latest/meta-data/x" alt="">')
    if (req.url === '/a' || req.url === '/b' || req.url === '/c') return page(`Page ${req.url}`, '<h1>Hi</h1>')
    res.writeHead(404).end()
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})
afterAll(() => new Promise<void>((r) => server.close(() => r())))

const rule: RuleMeta = { id: 'performance.seen', suite: 'performance', title: 'Seen', version: 1, severity: 'info', why: 'w', fix: 'f', docs_slug: 'x', tags: [] }

describe('browser stage', () => {
  it('loads the selected pages once each in Chromium and hands them to browser suites', async () => {
    const seen: { url: string; title: string; status: number | null }[] = []
    const suite: CheckSuite = {
      id: 'performance', version: '1', requires: ['http', 'browser'], rules: [rule], defaultSample: 3,
      async onBrowserPage(ctx, bp) {
        seen.push({ url: bp.url, title: await bp.page.title(), status: bp.status })
        await ctx.metric('load_ms', bp.loadMs, 'ms', bp.url)
      },
    }
    const sink = new MemorySink()
    const r = await crawl({ spec_version: 1, job_id: 'b', target: { start_url: `${origin}/` }, scope: { allow_private: true }, limits: { per_host_rps: 50 }, suites: { performance: { enabled: true } } },
      { sink, throttle: new HostThrottle(), suites: [suite] })
    expect(r.suiteErrors).toEqual([])
    expect(seen.map((s) => [s.url.replace(origin, ''), s.title, s.status])).toEqual([['/', 'Home', 200], ['/a', 'Page /a', 200], ['/b', 'Page /b', 200]])
    expect(sink.of('metric').map((m) => m.name)).toEqual(['load_ms', 'load_ms', 'load_ms'])
    expect(r.site!.browser!.pages).toBe(3)
    expect(r.site!.browser!.refused.map((x) => x.reason)).toContain('metadata')
    expect(r.summary.suites).toEqual([{ id: 'performance', version: '1', requires: ['http', 'browser'] }])
  }, 90_000)

  it('hands the start page to onHomePage: alone it loads that page only and keeps optional hooks out; with a suite it comes after the suite', async () => {
    const order: string[] = []
    const optional: CheckSuite = { id: 'ai_readiness', version: '1', requires: ['http'], rules: [], onBrowserPage(_c, bp) { order.push(`optional ${bp.url.replace(origin, '')}`) } }
    const spec = (suites: Record<string, { enabled: boolean }>) => ({ spec_version: 1 as const, job_id: 'o', target: { start_url: `${origin}/` }, scope: { allow_private: true }, limits: { per_host_rps: 50 }, suites })
    const alone = await crawl(spec({ ai_readiness: { enabled: true } }), { sink: new MemorySink(), throttle: new HostThrottle(), suites: [optional], onHomePage: async (bp) => { order.push(`home ${await bp.page.title()}`) } })
    expect(alone.suiteErrors).toEqual([])
    expect(alone.site!.browser!.pages).toBe(1)
    expect(order).toEqual(['home Home'])

    order.length = 0
    const browser: CheckSuite = { id: 'performance', version: '1', requires: ['http', 'browser'], rules: [rule], defaultSample: 2, selectPages: () => [`${origin}/a`, `${origin}/b`], onBrowserPage(_c, bp) { order.push(`suite ${bp.url.replace(origin, '')}`) } }
    const both = await crawl(spec({ performance: { enabled: true } }), { sink: new MemorySink(), throttle: new HostThrottle(), suites: [browser], onHomePage: () => { order.push('home'); throw new Error('camera jammed') } })
    // The start page is loaded first even though the suite did not pick it; a failing hook is recorded, not fatal.
    expect(order).toEqual(['home', 'suite /a', 'suite /b'])
    expect(both.site!.browser!.pages).toBe(3)
    expect(both.suiteErrors).toEqual([{ suite: 'engine', hook: 'onHomePage', url: `${origin}/`, message: 'camera jammed' }])
    expect(both.summary.status).toBe('completed')
  }, 120_000)

  it('loads each page once per profile: the phone is a small touch screen with Chrome for Android\'s name and ours, on a slower line', async () => {
    const seen: { profile: string; path: string; width: number; touch: boolean; ua: string; dpr: number }[] = []
    const everyDevice: CheckSuite = {
      id: 'performance', version: '1', requires: ['http', 'browser'], rules: [rule], defaultSample: 3, everyProfile: true,
      async onBrowserPage(ctx, bp) {
        const env = await bp.page.evaluate(() => ({ width: screen.width, touch: navigator.maxTouchPoints > 0, ua: navigator.userAgent, dpr: devicePixelRatio }))
        seen.push({ profile: bp.profile, path: bp.url.replace(origin, ''), ...env })
        await ctx.metric('load_ms', bp.loadMs, 'ms', bp.url)
        // The same problem on both devices, worse on the phone; and one only the phone has.
        await ctx.emit({ rule_id: rule.id, url: bp.url, severity: bp.profile === 'phone' ? 'high' : 'low', evidence: { as: bp.profile } })
        if (bp.profile === 'phone') await ctx.emit({ rule_id: rule.id, url: bp.url, evidence_key: 'phone-only', evidence: { only: true } })
      },
    }
    const firstOnly: CheckSuite = { id: 'a11y', version: '1', requires: ['http', 'browser'], rules: [], defaultSample: 3, onBrowserPage(_c, bp) { seen.push({ profile: `first-only ${bp.profile}`, path: bp.url.replace(origin, ''), width: 0, touch: false, ua: '', dpr: 0 }) } }
    const sink = new MemorySink()
    const r = await crawl({ spec_version: 1, job_id: 'p', target: { start_url: `${origin}/` }, scope: { allow_private: true }, limits: { per_host_rps: 50 }, suites: { performance: { enabled: true }, a11y: { enabled: true } }, browser: { profiles: ['desktop', 'phone'], extra_profile_pages: 2 } },
      { sink, throttle: new HostThrottle(), suites: [everyDevice, firstOnly] })
    expect(r.suiteErrors).toEqual([])
    const of = (p: string) => seen.filter((x) => x.profile === p)
    // Desktop: all three pages. Phone: the first two only (extra_profile_pages). The other suite sees desktop alone.
    expect(of('desktop').map((x) => x.path)).toEqual(['/', '/a', '/b'])
    expect(of('phone').map((x) => x.path)).toEqual(['/', '/a'])
    expect(of('first-only desktop')).toHaveLength(3)
    expect(of('first-only phone')).toHaveLength(0)
    expect(of('desktop')[0]).toMatchObject({ width: 1350, touch: false, dpr: 1 })
    expect(of('desktop')[0]!.ua).toContain('WebtraxBot/1.0')
    expect(of('phone')[0]).toMatchObject({ width: 412, touch: true, dpr: 2.625 })
    expect(of('phone')[0]!.ua).toMatch(/^Mozilla\/5\.0 \(Linux; Android 10; K\) AppleWebKit\/537\.36 \(KHTML, like Gecko\) Chrome\/\d+\.0\.0\.0 Mobile Safari\/537\.36 \(compatible; WebtraxBot\/1\.0; \+https:\/\/webtrax\.dev\/bot\)$/)
    expect(r.site!.browser).toMatchObject({ pages: 5, profiles: ['desktop', 'phone'] })
    // Metrics say which profile measured them.
    expect(sink.of('metric').map((m) => `${m.profile} ${m.device} ${m.url.replace(origin, '')}`)).toEqual(['desktop desktop /', 'desktop desktop /a', 'desktop desktop /b', 'phone mobile /', 'phone mobile /a'])
    // One finding per problem, whatever the number of profiles: the worst severity, and where it was seen.
    const at = (path: string) => r.findings.filter((f) => f.url === `${origin}${path}`).map((f) => [f.severity, f.evidence])
    expect(at('/')).toEqual([['high', { as: 'phone', profiles: ['desktop', 'phone'] }], ['info', { only: true, profiles: ['phone'] }]])
    expect(at('/b')).toEqual([['low', { as: 'desktop', profiles: ['desktop'] }]])
    expect(r.summary.findings).toMatchObject({ high: 2, low: 1, info: 2 })
    expect(new Set(sink.of('finding').map((f) => f.fingerprint)).size).toBe(sink.of('finding').length)
  }, 120_000)

  it('the phone\'s line is slower: a page with a 60 kB image loads later as a phone than as a desktop, every time', async () => {
    const big = http.createServer((req, res) => {
      if (req.url === '/big.bin') { res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'no-store' }); return res.end(Buffer.alloc(60_000, 1)) }
      res.writeHead(200, { 'content-type': 'text/html' })
      res.end('<!doctype html><html lang="en"><title>Heavy</title><body><h1>Heavy</h1><img src="/big.bin" alt="" width="10" height="10"></body></html>')
    })
    await new Promise<void>((r) => big.listen(0, '127.0.0.1', r))
    const at = `http://127.0.0.1:${(big.address() as AddressInfo).port}`
    const loads: Record<string, number[]> = { desktop: [], phone: [] }
    const timing: CheckSuite = { id: 'performance', version: '1', requires: ['http', 'browser'], rules: [], defaultSample: 1, everyProfile: true, onBrowserPage(_c, bp) { loads[bp.profile]!.push(bp.loadMs) } }
    try {
      for (let i = 0; i < 3; i++) {
        await crawl({ spec_version: 1, job_id: `s${i}`, target: { start_url: `${at}/` }, scope: { allow_private: true }, limits: { per_host_rps: 50 }, suites: { performance: { enabled: true } }, browser: { profiles: ['desktop', 'phone'] } },
          { sink: new MemorySink(), throttle: new HostThrottle(), suites: [timing] })
      }
    } finally {
      await new Promise<void>((r) => big.close(() => r()))
    }
    // 60 kB at 1.6 Mbit/s is 300 ms on its own, before the line's delay.
    expect(loads.desktop).toHaveLength(3)
    expect(Math.min(...loads.phone!)).toBeGreaterThan(Math.max(...loads.desktop!))
    expect(Math.min(...loads.phone!)).toBeGreaterThan(300)
  }, 120_000)

  it('does not start a browser when no browser suite runs', async () => {
    const r = await crawl({ spec_version: 1, job_id: 'h', target: { start_url: `${origin}/` }, scope: { allow_private: true }, limits: { per_host_rps: 50 } }, { sink: new MemorySink(), throttle: new HostThrottle() })
    expect(r.site!.browser).toBeUndefined()
  })
})

describe('browser stage with auth headers (a protected preview)', () => {
  it('loads protected pages with them, and sends them to no other origin', async () => {
    const thirdParty: (string | undefined)[] = []
    // Another origin (another port): a third party as far as origins go.
    const other = http.createServer((req, res) => {
      thirdParty.push(req.headers['x-vercel-protection-bypass'] as string | undefined)
      res.writeHead(200, { 'content-type': 'image/gif' }).end(Buffer.from('R0lGODlhAQABAAAAACw=', 'base64'))
    })
    await new Promise<void>((r) => other.listen(0, '127.0.0.1', r))
    const otherOrigin = `http://127.0.0.1:${(other.address() as AddressInfo).port}`
    let port = 0
    const locked = http.createServer((req, res) => {
      if (req.headers['x-vercel-protection-bypass'] !== 'k3y') { res.writeHead(401, { 'content-type': 'text/html' }).end('<!doctype html><title>Locked</title>'); return }
      res.writeHead(200, { 'content-type': 'text/html' })
      res.end(`<!doctype html><html lang="en"><title>Open</title><body><img src="${otherOrigin}/pixel.gif" alt=""></body></html>`)
    })
    await new Promise<void>((r) => locked.listen(0, '127.0.0.1', r))
    port = (locked.address() as AddressInfo).port
    try {
      const seen: { title: string; status: number | null }[] = []
      const suite: CheckSuite = {
        id: 'performance', version: '1', requires: ['http', 'browser'], rules: [rule], defaultSample: 1,
        async onBrowserPage(_ctx, bp) { seen.push({ title: await bp.page.title(), status: bp.status }) },
      }
      await crawl({ spec_version: 1, job_id: 'p', target: { start_url: `http://127.0.0.1:${port}/` }, scope: { allow_private: true }, limits: { per_host_rps: 50 }, suites: { performance: { enabled: true } }, auth: { headers: { 'x-vercel-protection-bypass': 'k3y' } } },
        { sink: new MemorySink(), throttle: new HostThrottle(), suites: [suite] })
      expect(seen).toEqual([{ title: 'Open', status: 200 }])
      expect(thirdParty.length).toBeGreaterThan(0)
      expect(thirdParty.every((v) => v === undefined)).toBe(true)
    } finally {
      await new Promise<void>((r) => locked.close(() => r()))
      await new Promise<void>((r) => other.close(() => r()))
    }
  }, 90_000)
})
