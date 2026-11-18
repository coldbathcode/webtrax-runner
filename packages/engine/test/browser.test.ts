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
