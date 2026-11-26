import { describe, expect, it } from 'vitest'
import { ALLOW_ALL, parseHtml, type CrawledPage, type FindingInput, type SuiteCtx } from '@webtrax/engine'
import { JobSpec, type PageRecord } from '@webtrax/protocol'
import { previewOrLocalHost, schemaProblems, seoSuite, THIN_WORDS, urlProblems } from '../src'

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

const words = (n: number, seed = 'w') => Array.from({ length: n }, (_, i) => `${seed}${i.toString(36)}`).join(' ')
const withMain = (main: string, head = '', attrs = 'lang="en"') => `<html ${attrs}><head><title>T</title><meta name="description" content="D">${OG}${head}</head><body><nav>${words(200, 'nav')}</nav><main><h1>T</h1>${main}</main><footer>${words(50, 'f')}</footer></body></html>`

describe('seo suite, third slice (C06.3)', () => {
  it('seo.content.thin: 20 to 149 words of main content on an indexable page, menus and footer left out', async () => {
    const s = setup()
    await seoSuite.onPage!(s.ctx, page(withMain(`<p>${words(60)}</p>`), {}, 200, '/thin'))
    await seoSuite.onPage!(s.ctx, page(withMain(`<p>${words(THIN_WORDS)}</p>`), {}, 200, '/full'))
    // Below 20 words is content.empty_page's; a noindex page, a form's page, one naming another canonical and a Japanese page are left alone.
    await seoSuite.onPage!(s.ctx, page(withMain('<p>Coming soon.</p>'), {}, 200, '/empty'))
    await seoSuite.onPage!(s.ctx, page(withMain(`<p>${words(60)}</p>`, '<meta name="robots" content="noindex">'), {}, 200, '/hidden'))
    await seoSuite.onPage!(s.ctx, page(withMain(`<p>${words(60)}</p><form><input name="q"></form>`), {}, 200, '/search'))
    // A newsletter box in the footer does not make it a form's page.
    await seoSuite.onPage!(s.ctx, page(withMain(`<p>${words(60)}</p>`).replace('</footer>', '<form><input name="email"></form></footer>'), {}, 200, '/news'))
    await seoSuite.onPage!(s.ctx, page(withMain(`<p>${words(60)}</p>`, `<link rel="canonical" href="${O}/full">`), {}, 200, '/copy'))
    await seoSuite.onPage!(s.ctx, page(withMain(`<p>${words(60)}</p>`, '', 'lang="ja"'), {}, 200, '/ja'))
    const thin = s.emitted.filter((f) => f.rule_id === 'seo.content.thin')
    expect(thin.map((f) => [f.url, f.evidence])).toEqual([[`${O}/thin`, { words: 61 }], [`${O}/news`, { words: 61 }]])
  })

  it('seo.schema.incomplete: required properties, per type, top-level entities only', async () => {
    expect(schemaProblems(JSON.stringify({ '@type': 'Product', name: 'Lamp' }))).toEqual([{ type: 'Product', missing: ['offers, review or aggregateRating'] }])
    expect(schemaProblems(JSON.stringify({ '@type': 'Product', name: 'Lamp', offers: { price: '9' } }))).toEqual([])
    expect(schemaProblems(JSON.stringify({ '@type': 'http://schema.org/Event', name: 'Fair' }))).toEqual([{ type: 'Event', missing: ['startDate', 'location'] }])
    expect(schemaProblems(JSON.stringify({ '@type': 'MusicEvent', name: 'Gig', startDate: '2026-12-01', location: { name: 'Hall' } }))).toEqual([])
    expect(schemaProblems(JSON.stringify({ '@type': ['Restaurant'], name: 'Cafe' }))).toEqual([{ type: 'LocalBusiness', missing: ['address'] }])
    // Breadcrumbs: every crumb needs a position and a name; all but the last a URL.
    const crumbs = { '@type': 'BreadcrumbList', itemListElement: [{ '@type': 'ListItem', position: 1, name: 'Home', item: `${O}/` }, { '@type': 'ListItem', position: 2, name: 'Shoes' }] }
    expect(schemaProblems(JSON.stringify(crumbs))).toEqual([])
    expect(schemaProblems(JSON.stringify({ ...crumbs, itemListElement: [{ position: 1, item: { '@id': `${O}/`, name: 'Home' } }, { name: 'Shoes' }, { position: 3, name: 'Red' }] })))
      .toEqual([{ type: 'BreadcrumbList', missing: ['itemListElement.position', 'itemListElement.item'] }])
    expect(schemaProblems(JSON.stringify({ '@type': 'FAQPage', mainEntity: [{ '@type': 'Question', name: 'Why?', acceptedAnswer: { text: 'Because.' } }, { '@type': 'Question', name: 'How?' }] })))
      .toEqual([{ type: 'FAQPage', missing: ['mainEntity.acceptedAnswer.text'] }])
    // A @graph, and an array of blocks; a nested publisher is not judged; unknown types and bad JSON are someone else's.
    expect(schemaProblems(JSON.stringify({ '@context': 'https://schema.org', '@graph': [{ '@type': 'WebSite', name: 'S' }, { '@type': 'Organization', url: O }] }))).toEqual([{ type: 'Organization', missing: ['name'] }])
    expect(schemaProblems(JSON.stringify([{ '@type': 'BlogPosting', headline: 'Hi', publisher: { '@type': 'Organization' } }]))).toEqual([])
    expect(schemaProblems(JSON.stringify({ '@type': 'Recipe' }))).toEqual([])
    expect(schemaProblems('{"@type": "Product",}')).toEqual([])

    const s = setup()
    const ld = (o: unknown) => `<script type="application/ld+json">${JSON.stringify(o)}</script>`
    await seoSuite.onPage!(s.ctx, page(GOOD.replace('</head>', `${ld({ '@type': 'Product', name: 'Lamp' })}${ld({ '@type': 'Product' })}${ld({ '@type': 'Event' })}</head>`)))
    // One finding per type on the page, with what is missing from any of its entities.
    expect(s.emitted.filter((f) => f.rule_id === 'seo.schema.incomplete').map((f) => [f.evidence_key, f.evidence])).toEqual([
      ['Product', { type: 'Product', missing: ['offers, review or aggregateRating', 'name'] }],
      ['Event', { type: 'Event', missing: ['name', 'startDate', 'location'] }],
    ])
  })

  it('seo.url.hygiene: one finding per kind for the whole site, from indexable pages only', async () => {
    expect(urlProblems(`${O}/Summer%20Sale`)).toEqual(['uppercase', 'spaces'])
    expect(urlProblems(`${O}/shop;jsessionid=AB12`)).toEqual(['session_id'])
    expect(urlProblems(`${O}/list?a=1&b=2&c=3&d=4&e=5&f=6&PHPSESSID=x`)).toEqual(['session_id', 'many_params'])
    expect(urlProblems(`${O}/${'a'.repeat(120)}`)).toEqual(['long'])
    // Underscores, a plus sign and capitals in the host or the query are fine.
    expect(urlProblems('https://Site.example/load_event/c++?Sort=Name')).toEqual([])
    // A language code in the path is not a capital letter problem (MDN's /en-US/); the rest of the path still counts.
    expect(urlProblems(`${O}/en-US/docs/web`)).toEqual([])
    expect(urlProblems(`${O}/zh-Hant-TW/a`)).toEqual([])
    expect(urlProblems(`${O}/en-US/docs/Web`)).toEqual(['uppercase'])

    const s = setup({}, {})
    await seoSuite.onPage!(s.ctx, page(GOOD, {}, 200, '/About-Us'))
    await seoSuite.onPage!(s.ctx, page(GOOD, {}, 200, '/Contact'))
    await seoSuite.onPage!(s.ctx, page(GOOD.replace('</head>', '<meta name="robots" content="noindex"></head>'), {}, 200, '/Hidden'))
    await seoSuite.onPage!(s.ctx, page(GOOD.replace('</head>', `<link rel="canonical" href="${O}/contact"></head>`), {}, 200, '/Contact-Old'))
    await seoSuite.onSite!(s.ctx, emptySite())
    const found = s.emitted.filter((f) => f.rule_id === 'seo.url.hygiene')
    expect(found).toEqual([{ rule_id: 'seo.url.hygiene', url: null, evidence_key: 'uppercase', title: 'Page addresses with capital letters', evidence: { problem: 'uppercase', pages: 2, examples: ['/About-Us', '/Contact'] } }])
  })

  it('seo.robots.blocks_assets: same-site stylesheets and scripts robots.txt keeps search engines from, with the line', async () => {
    const robots = 'User-agent: *\nDisallow: /admin\n\nUser-agent: Googlebot\nDisallow: /assets/private/\nDisallow: /js/\nAllow: /js/public.js\n'
    const s = setup({ [`${O}/robots.txt`]: robots })
    const head = '<link rel="stylesheet" href="/assets/private/site.css"><script src="/js/app.js"></script><script src="/js/public.js"></script><script src="https://cdn.example/js/x.js"></script><link rel="stylesheet" href="/css/ok.css">'
    await seoSuite.onPage!(s.ctx, page(GOOD.replace('</head>', `${head}</head>`), {}, 200, '/a'))
    await seoSuite.onPage!(s.ctx, page(GOOD.replace('</head>', '<script src="/js/app.js"></script></head>'), {}, 200, '/b'))
    await seoSuite.onSite!(s.ctx, emptySite())
    expect(s.emitted.filter((f) => f.rule_id === 'seo.robots.blocks_assets').map((f) => [f.url, f.source_url, f.evidence])).toEqual([
      [`${O}/js/app.js`, `${O}/a`, { kind: 'script', pages: 2, examples: ['/a', '/b'], line: 6, rule: 'Disallow: /js/' }],
      [`${O}/assets/private/site.css`, `${O}/a`, { kind: 'stylesheet', pages: 1, examples: ['/a'], line: 5, rule: 'Disallow: /assets/private/' }],
    ])
  })

  it('asks for robots.txt once, and only when a rule needs it', async () => {
    let asked = 0
    const s = setup({ [`${O}/robots.txt`]: 'User-agent: *\nDisallow:\n' })
    const text = s.ctx.text
    s.ctx.text = async (u, o) => { asked += 1; return text(u, o) }
    await seoSuite.onPage!(s.ctx, page(GOOD))
    await seoSuite.onSite!(s.ctx, emptySite())
    expect(asked).toBe(0)
    await seoSuite.onPage!(s.ctx, page(GOOD.replace('</head>', '<script src="/app.js"></script></head>')))
    await seoSuite.onSite!(s.ctx, emptySite([{ from: `${O}/sitemap.xml`, to: `${O}/p`, text: '', kind: 'sitemap' }]))
    expect(asked).toBe(1)
  })
})
