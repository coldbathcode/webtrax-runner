import { describe, expect, it } from 'vitest'
import { ALLOW_ALL, parseHtml, type CrawledPage, type FindingInput, type SuiteCtx } from '@webtrax/engine'
import { JobSpec, type PageRecord } from '@webtrax/protocol'
import { previewOrLocalHost, seoSuite } from '../src'

const O = 'https://site.example'
type Answer = { status: number | null; error?: 'dns_error' | 'connection_error'; body?: string }
function setup(texts: Record<string, string> = {}, answers: Record<string, Answer> = {}) {
  const emitted: FindingInput[] = []
  const asked: string[] = []
  const ctx: SuiteCtx = {
    spec: JobSpec.parse({ spec_version: 1, job_id: 'x', target: { start_url: `${O}/` } }), config: {}, origin: O, startUrl: `${O}/`, requestedStartUrl: `${O}/`,
    emit: async (f) => { emitted.push(f) }, metric: async () => {},
    // Anything not answered here does not resolve, as www. of a test domain would not.
    request: async (url) => { asked.push(url); const a = answers[url] ?? { status: null, error: 'dns_error' as const }; return { url, finalUrl: url, chain: [], timing: { ttfb: 1, total: 1 }, requests: 1, ...a } }, requestAs: async () => { throw new Error('no fetching') }, dns: async () => { throw new Error('no lookups') }, registration: async () => { throw new Error('no lookups') },
    text: async (url) => {
      if (!(url in texts)) throw new Error(`no fetching ${url}`)
      return { url, finalUrl: url, status: 200, chain: [], body: texts[url] ?? '', contentType: 'text/plain', timing: { ttfb: 1, total: 1 }, requests: 1 }
    },
  }
  return { ctx, emitted, asked, ids: () => emitted.map((f) => f.rule_id).sort() }
}
const page = (html: string, headers: Record<string, string> = {}, status = 200, path = '/p'): CrawledPage => ({
  url: `${O}${path}`, depth: 0, doc: parseHtml(html, `${O}${path}`), outcome: { url: `${O}${path}`, finalUrl: `${O}${path}`, status, chain: [], headers, timing: { ttfb: 1, total: 1 }, requests: 1 },
})
const emptySite = (edges: { from: string; to: string; text: string; kind: 'link' | 'sitemap' | 'canonical' }[] = []) =>
  ({ origin: O, startUrl: `${O}/`, requestedStartUrl: `${O}/`, robots: ALLOW_ALL, pages: new Map(), links: new Map(), edges, sitemapUrls: [] })
const OG = '<meta property="og:title" content="Pricing"><meta property="og:description" content="Plans"><meta property="og:image" content="/og.png">'
const GOOD = `<html lang="en"><head><title>Pricing</title><meta name="description" content="Plans and prices">${OG}</head><body><h1>Pricing</h1><h2>Pro</h2><h3>Limits</h3></body></html>`

describe('seo suite', () => {
  it('is quiet for a well-formed page', async () => {
    const s = setup()
    await seoSuite.onPage!(s.ctx, page(GOOD))
    expect(s.ids()).toEqual([])
  })

  it('reports each missing basic', async () => {
    const s = setup()
    await seoSuite.onPage!(s.ctx, page('<html><body><p>x</p></body></html>'))
    expect(s.ids()).toEqual(['seo.h1.missing', 'seo.lang.missing', 'seo.meta_description.missing', 'seo.social.og_missing', 'seo.title.missing'])
  })

  it('flags long titles, several h1s and noindex (meta or header)', async () => {
    const s = setup()
    await seoSuite.onPage!(s.ctx, page(GOOD.replace('<title>Pricing</title>', `<title>${'x'.repeat(71)}</title>`).replace('</h1>', '</h1><h1>Again</h1>').replace('<head>', '<head><meta name="robots" content="noindex, follow">')))
    expect(s.ids()).toEqual(['seo.h1.multiple', 'seo.noindex', 'seo.title.too_long'])
    const h = setup()
    await seoSuite.onPage!(h.ctx, page(GOOD, { 'x-robots-tag': 'noindex' }))
    expect(h.ids()).toEqual(['seo.noindex'])
  })

  it('ignores pages that did not return 200', async () => {
    const s = setup()
    await seoSuite.onPage!(s.ctx, page('<p>x</p>', {}, 404))
    expect(s.ids()).toEqual([])
  })

  it('finds duplicate titles across the site, one finding per page', async () => {
    const s = setup()
    const rec = (path: string, title: string, status = 200): PageRecord => ({ type: 'page', url: O + path, final_url: O + path, status, depth: 0, redirect_chain: [], title })
    const pages = new Map([rec('/a', 'Home'), rec('/b', 'home '), rec('/c', 'Other'), rec('/d', 'Home', 404)].map((p) => [p.url, p]))
    await seoSuite.onSite!(s.ctx, { origin: O, startUrl: `${O}/`, requestedStartUrl: `${O}/`, robots: ALLOW_ALL, pages, links: new Map(), edges: [], sitemapUrls: [] })
    expect(s.emitted.map((f) => [f.rule_id, f.url, f.evidence_key])).toEqual([['seo.title.duplicate', `${O}/a`, 'home'], ['seo.title.duplicate', `${O}/b`, 'home']])
  })

  it('treats pages with the same canonical URL as one page (found on webtrax.dev: /waitlist?v=b)', async () => {
    const s = setup()
    const rec = (path: string, title: string): PageRecord => ({ type: 'page', url: O + path, final_url: O + path, status: 200, depth: 0, redirect_chain: [], title })
    const pages = new Map([rec('/waitlist', 'Join'), rec('/waitlist?v=b', 'Join'), rec('/waitlist?v=a', 'Join')].map((p) => [p.url, p]))
    const edges = ['/waitlist', '/waitlist?v=b', '/waitlist?v=a'].map((p) => ({ from: O + p, to: `${O}/waitlist`, text: '', kind: 'canonical' as const }))
    await seoSuite.onSite!(s.ctx, { origin: O, startUrl: `${O}/`, requestedStartUrl: `${O}/`, robots: ALLOW_ALL, pages, links: new Map(), edges, sitemapUrls: [] })
    expect(s.emitted).toEqual([])
  })

  it('canonicals: several that disagree (tags or a Link header), or one on another site; www is the same site', async () => {
    const one = (extra: string, headers: Record<string, string> = {}) => page(GOOD.replace('<head>', `<head>${extra}`), headers)
    const s = setup()
    await seoSuite.onPage!(s.ctx, one('<link rel="canonical" href="/p"><link rel="canonical" href="/q">'))
    await seoSuite.onPage!(s.ctx, one('<link rel="canonical" href="/p">', { link: '</other>; rel="canonical"' }))
    expect(s.emitted.map((f) => f.rule_id)).toEqual(['seo.canonical.multiple', 'seo.canonical.multiple'])
    const same = setup()
    await seoSuite.onPage!(same.ctx, one('<link rel="canonical" href="/p"><link rel="canonical" href="https://site.example/p">', { link: '<https://site.example/p>; rel="canonical"' }))
    await seoSuite.onPage!(same.ctx, one('<link rel="canonical" href="https://www.site.example/p">'))
    expect(same.ids()).toEqual([])
    const cross = setup()
    await seoSuite.onPage!(cross.ctx, one('<link rel="canonical" href="https://staging.example.net/p">'))
    expect(cross.emitted).toEqual([expect.objectContaining({ rule_id: 'seo.canonical.cross_domain', evidence: { canonical: 'https://staging.example.net/p' } })])
    // A local build or a deploy preview names production: that is expected.
    for (const host of ['127.0.0.1:4321', 'localhost:3000', 'my-app-git-fix-team.vercel.app', 'deploy-preview-12--site.netlify.app']) {
      const p = setup()
      const url = `http://${host}/p`
      await seoSuite.onPage!(p.ctx, { ...page(GOOD.replace('<head>', '<head><link rel="canonical" href="https://site.example/p">')), url, doc: parseHtml(GOOD.replace('<head>', '<head><link rel="canonical" href="https://site.example/p">'), url) })
      expect(p.ids(), host).toEqual([])
    }
    expect(previewOrLocalHost('site.example')).toBe(false)
    expect(previewOrLocalHost('notvercel.app.example')).toBe(false)
  })

  it('social tags: only when all three are missing; skipped headings; nofollow on own links only', async () => {
    const s = setup()
    await seoSuite.onPage!(s.ctx, page(GOOD.replace('<meta property="og:image" content="/og.png">', '')))
    expect(s.ids()).toEqual([])
    await seoSuite.onPage!(s.ctx, page(GOOD.replace(OG, '<meta name="robots" content="noindex">')))
    expect(s.ids()).toEqual(['seo.noindex'])
    const h = setup()
    await seoSuite.onPage!(h.ctx, page(GOOD.replace('<h3>Limits</h3>', '<h4>Limits</h4><h2>Next</h2><h4>Again</h4>')))
    expect(h.emitted).toEqual([expect.objectContaining({ rule_id: 'seo.headings.skipped_level', evidence: { from: 'h2', to: 'h4', heading: 'Limits' } })])
    const n = setup()
    await seoSuite.onPage!(n.ctx, page(GOOD.replace('</body>', '<a href="/login" rel="nofollow">Log in</a><a href="https://ads.example/x" rel="nofollow sponsored">Ad</a><a href="/a">A</a></body>')))
    expect(n.emitted).toEqual([expect.objectContaining({ rule_id: 'seo.links.nofollow_internal', evidence: { links: 1, examples: [`${O}/login`] } })])
  })

  it('duplicate meta descriptions across pages, one finding per page', async () => {
    const s = setup()
    await seoSuite.onPage!(s.ctx, page(GOOD, {}, 200, '/a'))
    await seoSuite.onPage!(s.ctx, page(GOOD.replace('Plans and prices', 'plans  and prices'), {}, 200, '/b'))
    await seoSuite.onPage!(s.ctx, page(GOOD.replace('Plans and prices', 'Other'), {}, 200, '/c'))
    await seoSuite.onSite!(s.ctx, emptySite())
    expect(s.emitted.filter((f) => f.rule_id === 'seo.meta_description.duplicate').map((f) => f.url)).toEqual([`${O}/a`, `${O}/b`])
  })

  it('hreflang: bad codes, no self link, and alternates that do not link back', async () => {
    const alt = (links: [string, string][]) => GOOD.replace('<head>', `<head>${links.map(([l, h]) => `<link rel="alternate" hreflang="${l}" href="${h}">`).join('')}`)
    const s = setup()
    await seoSuite.onPage!(s.ctx, page(alt([['en', '/en'], ['de', '/de'], ['english', '/x']]), {}, 200, '/en'))
    await seoSuite.onPage!(s.ctx, page(alt([['de', '/de'], ['x-default', '/en']]), {}, 200, '/de'))
    await seoSuite.onPage!(s.ctx, page(alt([['fr-FR', '/fr'], ['en', '/en']]), {}, 200, '/fr'))
    await seoSuite.onSite!(s.ctx, emptySite())
    const found = s.emitted.filter((f) => f.rule_id === 'seo.hreflang.invalid').map((f) => [f.url, f.evidence_key, f.evidence!.problems])
    expect(found).toEqual([
      [`${O}/en`, 'page', ['invalid codes: english']],
      [`${O}/fr`, 'return', ['alternates do not link back']],
    ])
  })

  it('sitemap URLs that robots.txt blocks for search engines', async () => {
    const s = setup({ [`${O}/robots.txt`]: 'User-agent: *\nDisallow: /private/\n\nUser-agent: Googlebot\nDisallow: /drafts/\n' })
    const edges = ['/a', '/drafts/x', '/private/y'].map((p) => ({ from: `${O}/sitemap.xml`, to: O + p, text: '', kind: 'sitemap' as const }))
    await seoSuite.onSite!(s.ctx, emptySite(edges))
    // Googlebot follows its own group only, so /private/ is allowed for it.
    expect(s.emitted.map((f) => [f.rule_id, f.url])).toEqual([['seo.robots.blocks_sitemap_url', `${O}/drafts/x`]])
  })

  describe('second slice (C06.3)', () => {
    type Edge = { from: string; to: string; text: string; kind: 'link' | 'sitemap' | 'canonical' }
    const rec = (path: string, extra: Partial<PageRecord> = {}): [string, PageRecord] => [`${O}${path}`, { type: 'page', url: `${O}${path}`, final_url: `${O}${path}`, status: 200, redirect_chain: [], depth: 0, title: path, ...extra } as PageRecord]
    const siteOf = (paths: string[], edges: Edge[], extra: Record<string, Partial<PageRecord>> = {}) => ({ ...emptySite(edges), pages: new Map(paths.map((p) => rec(p, extra[p]))) })
    const link = (from: string, to: string): Edge => ({ from: `${O}${from}`, to: `${O}${to}`, text: '', kind: 'link' })

    it('a description longer than 160 characters, and not a shorter one', async () => {
      const s = setup()
      await seoSuite.onPage!(s.ctx, page(GOOD.replace('Plans and prices', 'x'.repeat(161)), {}, 200, '/long'))
      await seoSuite.onPage!(s.ctx, page(GOOD.replace('Plans and prices', 'x'.repeat(160)), {}, 200, '/ok'))
      expect(s.emitted.filter((f) => f.rule_id === 'seo.meta_description.too_long').map((f) => [f.url, f.evidence!.length])).toEqual([[`${O}/long`, 161]])
    })

    it('a canonical that names a noindex page; a self-canonical noindex page is not one', async () => {
      const s = setup()
      await seoSuite.onPage!(s.ctx, page(GOOD.replace('<head>', '<head><meta name="robots" content="noindex">'), {}, 200, '/hidden'))
      const edges: Edge[] = [{ from: `${O}/a`, to: `${O}/hidden`, text: '', kind: 'canonical' }, { from: `${O}/hidden`, to: `${O}/hidden`, text: '', kind: 'canonical' }]
      await seoSuite.onSite!(s.ctx, siteOf(['/', '/a', '/hidden'], edges))
      expect(s.emitted.filter((f) => f.rule_id === 'seo.canonical.to_noindex').map((f) => [f.url, f.evidence!.canonical])).toEqual([[`${O}/a`, `${O}/hidden`]])
    })

    it('a sitemap URL whose page names another canonical; not one that redirects, nor one that is its own', async () => {
      const s = setup({ [`${O}/robots.txt`]: 'User-agent: *\nDisallow:\n' })
      const edges: Edge[] = [
        ...['/a', '/b', '/moved'].map((p): Edge => ({ from: `${O}/sitemap.xml`, to: `${O}${p}`, text: '', kind: 'sitemap' })),
        { from: `${O}/a`, to: `${O}/b`, text: '', kind: 'canonical' },
        { from: `${O}/b`, to: `${O}/b`, text: '', kind: 'canonical' },
        { from: `${O}/new`, to: `${O}/b`, text: '', kind: 'canonical' },
      ]
      await seoSuite.onSite!(s.ctx, siteOf(['/', '/a', '/b', '/moved'], edges, { '/moved': { final_url: `${O}/new` } }))
      expect(s.emitted.filter((f) => f.rule_id === 'seo.canonical.sitemap_mismatch').map((f) => [f.url, f.evidence!.canonical])).toEqual([[`${O}/a`, `${O}/b`]])
    })

    it('pages more than four clicks away, by the shortest route, with the route', async () => {
      const s = setup()
      const chain = ['/', '/1', '/2', '/3', '/4', '/5', '/6']
      const edges = [...chain.slice(1).map((p, i) => link(chain[i]!, p)), link('/', '/shortcut'), link('/shortcut', '/6'), link('/5', '/not-html')]
      await seoSuite.onSite!(s.ctx, siteOf([...chain, '/shortcut', '/not-html'], edges, { '/not-html': { title: undefined } }))
      // /6 is two clicks away through /shortcut; /5 is five; a file that is not a page is never reported.
      expect(s.emitted.filter((f) => f.rule_id === 'seo.links.deep').map((f) => [f.url, f.evidence!.clicks, f.evidence!.route])).toEqual([[`${O}/5`, 5, ['/', '/1', '/2', '/3', '/4', '/5']]])
      // A crawl stopped by a limit may have missed the shorter route: it says nothing.
      const partial = setup()
      await seoSuite.onSite!(partial.ctx, { ...siteOf([...chain, '/shortcut', '/not-html'], edges, { '/not-html': { title: undefined } }), incomplete: 'page_limit' as const })
      expect(partial.emitted.filter((f) => f.rule_id === 'seo.links.deep')).toEqual([])
    })

    it('a social preview image that does not load, once for all the pages that use it', async () => {
      const img = (src: string) => GOOD.replace('content="/og.png"', `content="${src}"`)
      const s = setup({}, { [`${O}/og.png`]: { status: 200 }, [`${O}/gone.png`]: { status: 404 }, 'https://cdn.example/card.png': { status: 403 } })
      await seoSuite.onPage!(s.ctx, page(img('/gone.png'), {}, 200, '/a'))
      await seoSuite.onPage!(s.ctx, page(img('/gone.png'), {}, 200, '/b'))
      await seoSuite.onPage!(s.ctx, page(GOOD, {}, 200, '/c'))
      await seoSuite.onPage!(s.ctx, page(img('https://cdn.example/card.png'), {}, 200, '/d'))
      await seoSuite.onSite!(s.ctx, emptySite())
      // A 403 from a CDN that turns checkers away is not broken (V2-COR-03).
      expect(s.emitted.filter((f) => f.rule_id === 'seo.social.og_image_broken').map((f) => [f.url, f.source_url, f.evidence!.pages])).toEqual([[`${O}/gone.png`, `${O}/a`, 2]])
      expect(s.asked.filter((u) => u.endsWith('.png'))).toHaveLength(3)
    })

    it('www. and the bare domain both answering, unless one redirects or names the other as canonical', async () => {
      const run = async (answer: Answer) => {
        const s = setup({}, { 'https://www.site.example/': answer })
        await seoSuite.onSite!(s.ctx, emptySite())
        return s.emitted.filter((f) => f.rule_id === 'seo.host.not_canonicalised').map((f) => f.url)
      }
      expect(await run({ status: 200, body: '<html><head><title>Home</title></head></html>' })).toEqual(['https://www.site.example/'])
      expect(await run({ status: 200, body: '<link rel="canonical" href="https://www.site.example/">' })).toEqual(['https://www.site.example/'])
      expect(await run({ status: 200, body: '<link rel="canonical" href="https://site.example/">' })).toEqual([])
      expect(await run({ status: 301 })).toEqual([])
      expect(await run({ status: null, error: 'dns_error' })).toEqual([])
    })
  })
})
