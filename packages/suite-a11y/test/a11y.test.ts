import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { crawl, HostThrottle, MemorySink } from '@webtrax/engine'
import { A11Y_RULES, a11ySuite, ruleIdFor } from '../src'

let origin: string
let server: http.Server
beforeAll(async () => {
  server = http.createServer((req, res) => {
    // A strict CSP: axe must still run (it is evaluated over DevTools, not injected as a script).
    res.writeHead(200, { 'content-type': 'text/html', 'content-security-policy': "default-src 'self'; script-src 'none'" })
    if (req.url === '/') return res.end('<!doctype html><html><head><title>Bad</title></head><body><a href="/good">good</a><img src="/x.png"><input type="text"></body></html>')
    if (req.url === '/good') return res.end('<!doctype html><html lang="en"><head><title>Good</title></head><body><main><h1>Fine</h1><p>All good.</p></main></body></html>')
    res.end('')
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})
afterAll(() => new Promise<void>((r) => server.close(() => r())))

describe('a11y suite', () => {
  it('declares every WCAG A/AA axe rule with a docs slug', () => {
    expect(A11Y_RULES.length).toBeGreaterThan(50)
    expect(A11Y_RULES.find((r) => r.id === 'a11y.image_alt')).toMatchObject({ suite: 'a11y', docs_slug: 'a11y-image-alt' })
    expect(ruleIdFor('color-contrast')).toBe('a11y.color_contrast')
  })

  it('finds axe violations in Chromium, maps impact to severity, and passes a clean page', async () => {
    const r = await crawl(
      { spec_version: 1, job_id: 'a', target: { start_url: `${origin}/` }, scope: { allow_private: true }, limits: { per_host_rps: 50 }, suites: { a11y: { enabled: true } } },
      { sink: new MemorySink(), throttle: new HostThrottle(), suites: [a11ySuite] },
    )
    expect(r.suiteErrors).toEqual([])
    const byPage = (path: string) => r.findings.filter((f) => f.url === `${origin}${path}`).map((f) => f.rule_id).sort()
    expect(byPage('/')).toEqual(expect.arrayContaining(['a11y.html_has_lang', 'a11y.image_alt', 'a11y.label']))
    expect(byPage('/good')).toEqual([])
    const imageAlt = r.findings.find((f) => f.rule_id === 'a11y.image_alt')!
    expect(imageAlt.severity).toBe('high') // axe impact "critical"
    expect(imageAlt.evidence).toMatchObject({ impact: 'critical', count: 1 })
    expect(JSON.stringify(imageAlt.evidence).length).toBeLessThan(2048)
  }, 90_000)
})
