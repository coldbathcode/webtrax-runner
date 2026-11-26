import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { crawl, HostThrottle, MemorySink } from '@webtrax/engine'
import { assess, performanceSuite } from '../src'

describe('thresholds', () => {
  const base = { ttfb: 100, fcp: 300, lcp: 800, cls: 0, bytes: 100_000, requests: 5, domContentLoaded: 400 }
  it('is quiet for a fast page', () => expect(assess(base)).toEqual([]))
  it('grades LCP, CLS, TTFB and weight at the Core Web Vitals thresholds', () => {
    expect(assess({ ...base, lcp: 3000 }).map((f) => [f.rule_id, f.severity])).toEqual([['performance.lcp.slow', 'medium']])
    expect(assess({ ...base, lcp: 5000 })[0]!.severity).toBe('high')
    expect(assess({ ...base, cls: 0.15 })[0]).toMatchObject({ rule_id: 'performance.cls.high', severity: 'low' })
    expect(assess({ ...base, cls: 0.3 })[0]!.severity).toBe('medium')
    expect(assess({ ...base, ttfb: 900 })[0]).toMatchObject({ rule_id: 'performance.ttfb.slow', severity: 'low' })
    expect(assess({ ...base, bytes: 7 * 1024 * 1024 })[0]).toMatchObject({ rule_id: 'performance.page_weight', severity: 'medium' })
    expect(assess({ ...base, lcp: null })).toEqual([])
  })
})

let origin: string
let server: http.Server
beforeAll(async () => {
  server = http.createServer((req, res) => {
    if (req.url === '/slow') return setTimeout(() => { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<!doctype html><title>Slow</title><h1>Slow</h1>') }, 1000)
    res.writeHead(200, { 'content-type': 'text/html' })
    res.end('<!doctype html><title>Home</title><h1>Hello</h1><p>Some text for a paint.</p><a href="/slow">slow</a>')
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})
afterAll(() => new Promise<void>((r) => server.close(() => r())))

describe('performance suite in Chromium', () => {
  it('records metrics for each sampled page and flags a slow server', async () => {
    const sink = new MemorySink()
    const r = await crawl(
      { spec_version: 1, job_id: 'p', target: { start_url: `${origin}/` }, scope: { allow_private: true }, limits: { per_host_rps: 50 }, suites: { performance: { enabled: true } } },
      { sink, throttle: new HostThrottle(), suites: [performanceSuite] },
    )
    expect(r.suiteErrors).toEqual([])
    const names = new Set(sink.of('metric').map((m) => m.name))
    for (const n of ['ttfb_ms', 'fcp_ms', 'lcp_ms', 'cls', 'transfer_bytes', 'requests', 'load_ms']) expect(names, n).toContain(n)
    const slow = r.findings.find((f) => f.rule_id === 'performance.ttfb.slow')
    expect(slow?.url).toBe(`${origin}/slow`)
  }, 90_000)

  it('measures as a desktop and as a phone, and the slow line of the phone alone never blames the server', async () => {
    const sink = new MemorySink()
    const r = await crawl(
      { spec_version: 1, job_id: 'd', target: { start_url: `${origin}/` }, scope: { allow_private: true }, limits: { per_host_rps: 50 }, suites: { performance: { enabled: true } }, browser: { profiles: ['desktop', 'phone'] } },
      { sink, throttle: new HostThrottle(), suites: [performanceSuite] },
    )
    expect(r.suiteErrors).toEqual([])
    const ttfb = (profile: string, path: string) => sink.of('metric').find((m) => m.name === 'ttfb_ms' && m.profile === profile && m.url === `${origin}${path}`)!.value
    // The phone's line delays every first byte (about 75 ms here; a local answer without it takes a few). Checked
    // against the delay itself, not the desktop's sample: on a busy machine the desktop's first byte has taken 160 ms.
    expect(ttfb('phone', '/')).toBeGreaterThanOrEqual(60)
    // /slow is slow on both, but only the desktop measurement can say so about the server.
    const slow = r.findings.filter((f) => f.rule_id === 'performance.ttfb.slow')
    expect(slow.map((f) => [f.url, f.evidence.profiles])).toEqual([[`${origin}/slow`, ['desktop']]])
    // The home page answers at once: the phone's slower first byte is the line, and is not reported.
    expect(r.findings.filter((f) => f.url === `${origin}/`)).toEqual([])
  }, 120_000)
})

describe('engines compared (C06.10 slice d)', () => {
  it('flags a page one engine downloads 30% and 100 kB more of, at the same size only', async () => {
    const { engineWeightDiffers } = await import('../src')
    expect(engineWeightDiffers({ desktop: 330_000, 'webkit-desktop': 495_000, 'firefox-desktop': 317_000 })).toMatchObject({ heaviest: 'webkit-desktop', lightest: 'firefox-desktop' })
    // Under 100 kB apart, or under 30% more, is the same page.
    expect(engineWeightDiffers({ desktop: 300_000, 'webkit-desktop': 380_000 })).toBeNull()
    expect(engineWeightDiffers({ desktop: 2_000_000, 'firefox-desktop': 2_400_000 })).toBeNull()
    // A phone rightly loads less than a desktop: not compared across sizes.
    expect(engineWeightDiffers({ desktop: 900_000, phone: 300_000 })).toBeNull()
    expect(engineWeightDiffers({ phone: 300_000, 'webkit-phone': 600_000 })).toMatchObject({ heaviest: 'webkit-phone', lightest: 'phone' })
    expect(engineWeightDiffers({ desktop: 300_000 })).toBeNull()
  })
})
