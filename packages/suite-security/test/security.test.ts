import { describe, expect, it } from 'vitest'
import { parseHtml, type CrawledPage, type FindingInput, type Outcome, type SuiteCtx } from '@webtrax/engine'
import { JobSpec } from '@webtrax/protocol'
import { isLocalHost, securitySuite, unsafeCspSources } from '../src'

const GOOD = {
  'strict-transport-security': 'max-age=31536000; includeSubDomains', 'content-security-policy': "default-src 'self'; frame-ancestors 'none'",
  'x-content-type-options': 'nosniff', 'referrer-policy': 'strict-origin-when-cross-origin', 'permissions-policy': 'camera=()',
}

function setup(start: string, httpAnswer: Partial<Outcome> = { status: 301, finalUrl: start }) {
  const emitted: FindingInput[] = []
  const requested: string[] = []
  const ctx: SuiteCtx = {
    spec: JobSpec.parse({ spec_version: 1, job_id: 'x', target: { start_url: start } }), config: {}, origin: new URL(start).origin, startUrl: start, requestedStartUrl: start,
    emit: async (f) => { emitted.push(f) }, metric: async () => {},
    request: async (url) => { requested.push(url); return { url, finalUrl: url, status: null, chain: [], timing: { ttfb: 0, total: 0 }, requests: 1, ...httpAnswer } },
  }
  const page = (url: string, headers: Record<string, string>, html = '<p>x</p>'): CrawledPage => ({
    url, depth: 0, doc: parseHtml(html, url), outcome: { url, finalUrl: url, status: 200, chain: [], headers, timing: { ttfb: 1, total: 1 }, requests: 1 },
  })
  return { ctx, page, requested, ids: () => emitted.map((f) => f.rule_id).sort(), emitted }
}

describe('security suite: start page headers', () => {
  it('is quiet for a well-configured HTTPS site that upgrades HTTP', async () => {
    const s = setup('https://site.example/')
    await securitySuite.onPage!(s.ctx, s.page('https://site.example/', GOOD))
    expect(s.ids()).toEqual([])
    expect(s.requested).toEqual(['http://site.example/'])
  })

  it('reports each missing header once, on the start page only', async () => {
    const s = setup('https://site.example/')
    await securitySuite.onPage!(s.ctx, s.page('https://site.example/', {}))
    await securitySuite.onPage!(s.ctx, s.page('https://site.example/other', {}))
    expect(s.ids()).toEqual([
      'security.header.csp_missing', 'security.header.frame_protection_missing', 'security.header.hsts_missing', 'security.header.nosniff_missing',
      'security.header.permissions_policy_missing', 'security.header.referrer_policy_missing',
    ])
  })

  it('flags short HSTS, unsafe CSP, report-only CSP and version disclosure', async () => {
    const s = setup('https://site.example/')
    await securitySuite.onPage!(s.ctx, s.page('https://site.example/', { ...GOOD, 'strict-transport-security': 'max-age=300', 'content-security-policy': "script-src 'self' 'unsafe-inline'", 'x-frame-options': 'DENY', server: 'nginx/1.25.3', 'x-powered-by': 'Express' }))
    expect(s.ids()).toEqual(['security.disclosure.version', 'security.header.csp_unsafe', 'security.header.hsts_short'])
    const r = setup('https://site.example/')
    const { 'content-security-policy': _csp, ...noCsp } = GOOD
    await securitySuite.onPage!(r.ctx, r.page('https://site.example/', { ...noCsp, 'content-security-policy-report-only': "default-src 'self'", 'x-frame-options': 'SAMEORIGIN' }))
    expect(r.emitted).toEqual([{ rule_id: 'security.header.csp_missing', url: 'https://site.example/', severity: 'low', evidence: { mode: 'report-only' } }])
  })

  it('reports HTTP that does not upgrade, and plain-HTTP sites', async () => {
    const s = setup('https://site.example/', { status: 200 })
    await securitySuite.onPage!(s.ctx, s.page('https://site.example/', GOOD))
    expect(s.ids()).toEqual(['security.https.not_enforced'])
    const h = setup('http://site.example/')
    await securitySuite.onPage!(h.ctx, h.page('http://site.example/', GOOD))
    expect(h.ids()).toEqual(['security.https.missing'])
  })

  it('skips HTTPS rules for local dev servers', async () => {
    const s = setup('http://localhost:3000/')
    await securitySuite.onPage!(s.ctx, s.page('http://localhost:3000/', GOOD))
    expect(s.ids()).toEqual([])
    expect(s.requested).toEqual([])
  })
})

describe('security suite: page content', () => {
  it('finds mixed content and insecure forms on HTTPS pages', async () => {
    const s = setup('https://site.example/')
    await securitySuite.onPage!(s.ctx, s.page('https://site.example/p', {}, '<img src="http://cdn.example/a.png"><script src="//x.example/s.js"></script><link rel="stylesheet" href="http://cdn.example/s.css"><form action="http://site.example/login"></form><form action="/ok"></form>'))
    expect(s.ids()).toEqual(['security.form.insecure_action', 'security.mixed_content'])
    expect(s.emitted.find((f) => f.rule_id === 'security.mixed_content')?.evidence).toEqual({ count: 2, examples: ['http://cdn.example/a.png', 'http://cdn.example/s.css'] })
  })

  it('finds password fields on public HTTP pages', async () => {
    const s = setup('http://site.example/')
    await securitySuite.onPage!(s.ctx, s.page('http://site.example/login', {}, '<input type="password">'))
    expect(s.ids()).toEqual(['security.form.password_over_http'])
  })
})

describe('helpers', () => {
  it('reads CSP script sources, honouring nonces', () => {
    expect(unsafeCspSources("default-src 'self' 'unsafe-inline' *")).toEqual(["'unsafe-inline'", '*'])
    expect(unsafeCspSources("script-src 'self' 'unsafe-inline' 'nonce-abc'")).toEqual([])
    expect(unsafeCspSources("script-src 'self' 'unsafe-eval'")).toEqual(["'unsafe-eval'"])
    expect(unsafeCspSources("img-src *")).toEqual([])
  })
  it('knows local hosts', () => {
    for (const h of ['localhost', 'app.localhost', 'nas.local', '127.0.0.1', '[::1]', 'site.test']) expect(isLocalHost(h), h).toBe(true)
    expect(isLocalHost('example.com')).toBe(false)
  })
})
