import { describe, expect, it } from 'vitest'
import { ALLOW_ALL, parseHtml, type CrawledPage, type FindingInput, type LinkOutcome, type SiteState, type SuiteCtx } from '@webtrax/engine'
import { JobSpec } from '@webtrax/protocol'
import { linksSuite, resolveOutcome } from '../src'

const O = 'https://site.test'
function ctx(start = `${O}/`) {
  const emitted: FindingInput[] = []
  const c: SuiteCtx = {
    spec: JobSpec.parse({ spec_version: 1, job_id: 'x', target: { start_url: start } }), config: {}, origin: O, startUrl: `${O}/`, requestedStartUrl: start,
    emit: async (f) => { emitted.push(f) }, metric: async () => {}, request: async () => { throw new Error('links suite must not fetch') },
  }
  return { c, emitted, rules: () => emitted.map((f) => `${f.rule_id} ${f.url}${f.source_url ? ` <- ${f.source_url}` : ''}`) }
}
const out = (url: string, o: Partial<LinkOutcome> = {}): LinkOutcome => ({ url, internal: url.startsWith(O), via: 'crawl', status: 200, finalUrl: url, chain: [], ...o })
function site(links: LinkOutcome[], edges: SiteState['edges'], over: Partial<SiteState> = {}): SiteState {
  return { origin: O, startUrl: `${O}/`, requestedStartUrl: `${O}/`, robots: ALLOW_ALL, pages: new Map(), links: new Map(links.map((l) => [l.url, l])), edges, sitemapUrls: [], ...over }
}
const link = (from: string, to: string) => ({ from, to, text: 'x', kind: 'link' as const })

describe('links suite: onSite', () => {
  it('classifies broken targets by cause', async () => {
    const { c, rules } = ctx()
    await linksSuite.onSite!(c, site(
      [out(`${O}/gone`, { status: 410 }), out('https://ext.test/x', { status: 404 }), out('https://slow.test/', { status: null, error: 'timeout' }),
        out('https://dead.test/', { status: null, error: 'dns_error' }), out('https://tls.test/', { status: null, error: 'tls_error' }),
        out('https://busy.test/', { status: null, error: 'rate_limited' })],
      ['/gone', 'https://ext.test/x', 'https://slow.test/', 'https://dead.test/', 'https://tls.test/', 'https://busy.test/'].map((t) => link(`${O}/`, t.startsWith('/') ? O + t : t)),
    ))
    expect(rules()).toEqual([
      `links.broken.internal ${O}/gone <- ${O}/`,
      `links.broken.external https://ext.test/x <- ${O}/`,
      `links.timeout https://slow.test/ <- ${O}/`,
      `links.dns_failure https://dead.test/ <- ${O}/`,
      `links.unreachable https://tls.test/ <- ${O}/`,
      'links.host_rate_limited https://busy.test/',
    ])
  })

  it('follows redirects the crawl stopped at a known page, counting hops', async () => {
    const s = site([out(`${O}/a`, { status: 301, finalUrl: `${O}/b`, chain: [{ url: `${O}/a`, status: 301 }] }),
      out(`${O}/b`, { status: 302, finalUrl: `${O}/c`, chain: [{ url: `${O}/b`, status: 302 }] }),
      out(`${O}/c`, { status: 200, chain: [{ url: `${O}/c`, status: 301 }], finalUrl: `${O}/d` })], [link(`${O}/`, `${O}/a`)])
    expect(resolveOutcome(s, `${O}/a`)).toMatchObject({ hops: 3, outcome: { url: `${O}/c`, status: 200 } })
    const { c, rules } = ctx()
    await linksSuite.onSite!(c, s)
    expect(rules()).toEqual([`links.redirect.chain ${O}/a <- ${O}/`])
  })

  it('reports a redirect that ends broken as broken, not as a chain', async () => {
    const { c, rules } = ctx()
    await linksSuite.onSite!(c, site([out(`${O}/old`, { status: 301, finalUrl: `${O}/new`, chain: [{ url: `${O}/old`, status: 301 }] }), out(`${O}/new`, { status: 404 })], [link(`${O}/`, `${O}/old`)]))
    expect(rules()).toEqual([`links.broken.internal ${O}/old <- ${O}/`])
  })

  it('accepts one or two redirect hops, and does not call a linked sitemap page an orphan', async () => {
    const { c, rules } = ctx()
    await linksSuite.onSite!(c, site(
      [out(`${O}/one`, { status: 301, finalUrl: `${O}/two`, chain: [{ url: `${O}/one`, status: 301 }] }), out(`${O}/two`, { chain: [{ url: `${O}/two`, status: 302 }], finalUrl: `${O}/three` }), out(`${O}/linked`)],
      [link(`${O}/`, `${O}/one`), link(`${O}/`, `${O}/linked`), { from: `${O}/sitemap.xml`, to: `${O}/linked`, text: '', kind: 'sitemap' }],
    ))
    expect(rules()).toEqual([])
  })

  it('flags HTTPS pages linking to HTTP', async () => {
    const { c, rules } = ctx()
    await linksSuite.onSite!(c, site([out('http://ext.test/')], [link(`${O}/`, 'http://ext.test/')]))
    expect(rules()).toEqual([`links.redirect.to_http http://ext.test/ <- ${O}/`])
  })

  it('reports stale sitemap entries, orphans and broken canonicals', async () => {
    const { c, rules } = ctx()
    await linksSuite.onSite!(c, site(
      [out(`${O}/orphan`), out(`${O}/gone`, { status: 404 }), out(`${O}/moved`, { status: 301, finalUrl: 'https://other.test/', chain: [{ url: `${O}/moved`, status: 301 }] }), out(`${O}/canon`, { status: 404 }),
        out(`${O}/p.html`, { status: 200, finalUrl: `${O}/p`, chain: [{ url: `${O}/p.html`, status: 301 }] }), out(`${O}/q`)],
      [{ from: `${O}/sitemap.xml`, to: `${O}/orphan`, text: '', kind: 'sitemap' }, { from: `${O}/sitemap.xml`, to: `${O}/gone`, text: '', kind: 'sitemap' },
        { from: `${O}/sitemap.xml`, to: `${O}/moved`, text: '', kind: 'sitemap' }, { from: `${O}/`, to: `${O}/canon`, text: '', kind: 'canonical' },
        { from: `${O}/p`, to: `${O}/p.html`, text: '', kind: 'canonical' }, { from: `${O}/r`, to: `${O}/q`, text: '', kind: 'canonical' }],
    ))
    expect(rules().sort()).toEqual([
      `links.canonical.broken ${O}/canon <- ${O}/`,
      `links.canonical.broken ${O}/p.html <- ${O}/p`,
      `links.orphan ${O}/orphan`,
      `links.sitemap.stale ${O}/gone <- ${O}/sitemap.xml`,
      `links.sitemap.stale ${O}/moved <- ${O}/sitemap.xml`,
    ].sort())
  })

  it('notes a redirected start URL', async () => {
    const { c, rules } = ctx(`http://site.test/`)
    await linksSuite.onSite!(c, site([], [], { requestedStartUrl: 'http://site.test/' }))
    expect(rules()).toEqual(['links.redirect.start http://site.test/'])
  })
})

describe('links suite: soft 404', () => {
  const page = (html: string, status = 200): CrawledPage => ({
    url: `${O}/p`, depth: 1, doc: parseHtml(html, `${O}/p`),
    outcome: { url: `${O}/p`, finalUrl: `${O}/p`, status, chain: [], timing: { ttfb: 1, total: 1 }, requests: 1 },
  })
  it('flags a 200 page that says it was not found', async () => {
    const { c, rules } = ctx()
    await linksSuite.onPage!(c, page('<title>Page not found</title><h1>Oops</h1>'))
    await linksSuite.onPage!(c, page('<title>Shop</title><h1>404 — nothing here</h1>'))
    await linksSuite.onPage!(c, page('<title>Not found</title>', 404))
    await linksSuite.onPage!(c, page('<title>Found our new office</title><h1>Welcome</h1>'))
    expect(rules()).toEqual([`links.soft_404 ${O}/p`, `links.soft_404 ${O}/p`])
  })

  it('does not flag pages that are about errors (found on the Webtrax docs)', async () => {
    const { c, rules } = ctx()
    for (const html of [
      '<title>Page says "not found" but returns 200 · Webtrax docs</title><h1>Page says "not found" but returns 200</h1>',
      '<title>How to fix a 404 page</title><h1>How to fix a 404 page</h1>',
      '<title>Page does not declare its language · Webtrax docs</title><h1>Page does not declare its language</h1>',
      '<title>Not found what you need? Ask us</title><h1>Help</h1>'.replace('Not found what', 'Have not found what'),
    ]) await linksSuite.onPage!(c, page(html))
    expect(rules()).toEqual([])
    for (const html of ['<title>Error 404 | Shop</title><h1>Oh no</h1>', '<title>Shop</title><h1>Sorry, this page has moved</h1>', '<title>Oops! Page not found – Blog</title>', '<title>Blog</title><h1>This page does not exist</h1>', "<title>Help</title><h1>The page can't be found</h1>"]) await linksSuite.onPage!(c, page(html))
    expect(rules()).toHaveLength(5)
  })
})

describe('rules', () => {
  it('every rule is declared once and well formed', () => {
    const ids = linksSuite.rules.map((r) => r.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const r of linksSuite.rules) expect(r.id.startsWith('links.')).toBe(true)
  })
})
