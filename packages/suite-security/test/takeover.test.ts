// Takeover watch (C06.9 slice e, F-A24): a script from a domain anyone can
// register, and a subdomain aliased to a service with nothing claimed on it,
// give one finding each; a clean site gives none. DNS, the registry and the
// one GET are fakes: the suite only ever asks, it never claims.
import { describe, expect, it } from 'vitest'
import { parseHtml, type CrawledPage, type DnsAnswer, type FindingInput, type LinkOutcome, type Registration, type SiteState, type SuiteCtx } from '@webtrax/engine'
import { JobSpec } from '@webtrax/protocol'
import { registrableDomain } from '@webtrax/engine'
import { securitySuite, serviceFor } from '../src'

const O = 'https://shop.example.com'
const ok = (cname: string[] = []): DnsAnswer => ({ status: 'ok', cname, addresses: ['203.0.113.7'] })
const nx = (cname: string[] = []): DnsAnswer => ({ status: 'nxdomain', cname, addresses: [] })

function run(opts: { html: string; links?: { url: string; error?: 'dns_error' }[]; dns: Record<string, DnsAnswer>; registry?: Record<string, Registration>; bodies?: Record<string, string> }) {
  const emitted: FindingInput[] = []
  const asked: string[] = []
  const ctx: SuiteCtx = {
    spec: JobSpec.parse({ spec_version: 1, job_id: 'x', target: { start_url: `${O}/` } }), config: {}, origin: O, startUrl: `${O}/`, requestedStartUrl: `${O}/`,
    emit: async (f) => { emitted.push(f) }, metric: async () => {},
    request: async (url) => ({ url, finalUrl: url, status: 301, chain: [], timing: { ttfb: 0, total: 0 }, requests: 1 }),
    requestAs: async () => { throw new Error('not used') },
    text: async (url) => { asked.push(`GET ${url}`); return { url, finalUrl: url, status: 200, chain: [], timing: { ttfb: 0, total: 0 }, requests: 1, body: opts.bodies?.[url] ?? '<p>a site</p>' } },
    dns: async (host) => { asked.push(`dns ${host}`); return opts.dns[host] ?? ok() },
    registration: async (domain) => { asked.push(`rdap ${domain}`); return opts.registry?.[domain] ?? 'registered' },
  }
  // The crawl's edges: every anchor on the page, with an outcome for those `links` names.
  const anchors = [...opts.html.matchAll(/<a href="([^"]+)"/g)].map((m) => new URL(m[1]!, `${O}/`).toString())
  const links = new Map<string, LinkOutcome>((opts.links ?? []).map((l) => [l.url, { url: l.url, internal: false, via: 'check', status: l.error ? null : 200, ...(l.error ? { error: l.error } : {}), finalUrl: l.url, chain: [] }]))
  const site = { origin: O, startUrl: `${O}/`, requestedStartUrl: `${O}/`, pages: new Map(), links, edges: [...new Set([...anchors, ...(opts.links ?? []).map((l) => l.url)])].map((to) => ({ from: `${O}/`, to, text: '', kind: 'link' as const })), sitemapUrls: [] } as unknown as SiteState
  const page: CrawledPage = { url: `${O}/`, depth: 0, doc: parseHtml(opts.html, `${O}/`), outcome: { url: `${O}/`, finalUrl: `${O}/`, status: 200, chain: [], headers: {}, timing: { ttfb: 1, total: 1 }, requests: 1 } }
  return { emitted, asked, go: async () => { await securitySuite.onPage!(ctx, page); await securitySuite.onSite!(ctx, site) } }
}
const takeover = (f: FindingInput[]) => f.filter((x) => x.rule_id.startsWith('security.takeover.'))

describe('takeover watch', () => {
  it('reports a script from a domain anyone can register, and a subdomain aliased to an unclaimed GitHub Pages site', async () => {
    const r = run({
      html: '<script src="https://cdn.gone-vendor.com/w.js"></script><script src="https://cdn.gone-vendor.com/x.js"></script><a href="https://docs.example.com/">Docs</a>',
      dns: { 'cdn.gone-vendor.com': nx(), 'docs.example.com': ok(['shop-docs.github.io']) },
      registry: { 'gone-vendor.com': 'available' },
      bodies: { 'https://docs.example.com/': '<h1>404</h1><p>There isn\'t a GitHub Pages site here.</p>' },
    })
    await r.go()
    const found = takeover(r.emitted)
    expect(found.map((f) => [f.rule_id, f.severity, f.evidence_key])).toEqual([
      ['security.takeover.domain_available', 'critical', 'gone-vendor.com'],
      ['security.takeover.dangling_cname', undefined, 'docs.example.com'],
    ])
    expect(found[0]).toMatchObject({ url: 'https://cdn.gone-vendor.com/w.js', source_url: `${O}/`, evidence: { used_as: 'script', dns: 'does not exist', registry: 'not registered', pages: ['/'] } })
    expect(found[1]).toMatchObject({ url: 'https://docs.example.com/', evidence: { service: 'GitHub Pages', cname: ['shop-docs.github.io'], proof: expect.stringContaining('There isn\'t a GitHub Pages site here') } })
  })

  it('says nothing about a clean site, and asks the registry only about names that do not exist', async () => {
    const r = run({
      html: '<script src="https://cdn.vendor.com/w.js"></script><link rel="stylesheet" href="https://fonts.example.net/a.css"><a href="https://blog.example.com/">Blog</a>',
      links: [{ url: 'https://partner.example.org/' }],
      dns: { 'blog.example.com': ok(['shop.github.io']) },
    })
    await r.go()
    expect(takeover(r.emitted)).toEqual([])
    expect(r.asked.filter((a) => a.startsWith('rdap'))).toEqual([])
    // A link the crawl reached is not looked up again.
    expect(r.asked).not.toContain('dns partner.example.org')
  })

  it('a registered domain that does not resolve, or a registry that cannot say, is not reported', async () => {
    for (const registry of ['registered', 'unknown'] as const) {
      const r = run({ html: '<a href="https://old.partner.io/x">x</a>', links: [{ url: 'https://old.partner.io/x', error: 'dns_error' }], dns: { 'old.partner.io': nx() }, registry: { 'partner.io': registry } })
      await r.go()
      expect(takeover(r.emitted)).toEqual([])
    }
    const r = run({ html: '<a href="https://old.partner.io/x">x</a>', links: [{ url: 'https://old.partner.io/x', error: 'dns_error' }], dns: { 'old.partner.io': nx() }, registry: { 'partner.io': 'available' } })
    await r.go()
    expect(takeover(r.emitted).map((f) => [f.severity, f.evidence_key])).toEqual([['medium', 'partner.io']])
  })

  it('an alias to Azure whose target is gone is dangling without any request; one to an unlisted service is not', async () => {
    const r = run({ html: '<a href="https://app.example.com/">App</a> <a href="https://cdn2.example.com/">CDN</a>', dns: { 'app.example.com': nx(['shop-app.azurewebsites.net']), 'cdn2.example.com': nx(['d123.cloudfront.net']) } })
    await r.go()
    expect(takeover(r.emitted).map((f) => [f.rule_id, f.evidence_key])).toEqual([['security.takeover.dangling_cname', 'app.example.com']])
    expect(r.asked.filter((a) => a.startsWith('GET'))).toEqual([])
  })

  it('knows registrable domains and the services', () => {
    expect(['shop.example.com', 'a.b.example.co.uk', 'example.com.au', 'name.github.io', 'localhost', '203.0.113.7'].map(registrableDomain)).toEqual(['example.com', 'example.co.uk', 'example.com.au', 'github.io', null, null])
    expect(serviceFor('bucket.s3.amazonaws.com')?.name).toBe('Amazon S3')
    expect(serviceFor('x.s3-website-eu-west-1.amazonaws.com')?.name).toBe('Amazon S3')
    expect(serviceFor('example.com')).toBeUndefined()
  })
})
