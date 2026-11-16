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
