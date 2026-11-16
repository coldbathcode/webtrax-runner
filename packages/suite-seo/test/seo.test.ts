import { describe, expect, it } from 'vitest'
import { ALLOW_ALL, parseHtml, type CrawledPage, type FindingInput, type SuiteCtx } from '@webtrax/engine'
import { JobSpec, type PageRecord } from '@webtrax/protocol'
import { seoSuite } from '../src'

const O = 'https://site.example'
function setup() {
  const emitted: FindingInput[] = []
  const ctx: SuiteCtx = {
    spec: JobSpec.parse({ spec_version: 1, job_id: 'x', target: { start_url: `${O}/` } }), config: {}, origin: O, startUrl: `${O}/`, requestedStartUrl: `${O}/`,
    emit: async (f) => { emitted.push(f) }, metric: async () => {}, request: async () => { throw new Error('no fetching') },
  }
  return { ctx, emitted, ids: () => emitted.map((f) => f.rule_id).sort() }
}
const page = (html: string, headers: Record<string, string> = {}, status = 200): CrawledPage => ({
  url: `${O}/p`, depth: 0, doc: parseHtml(html, `${O}/p`), outcome: { url: `${O}/p`, finalUrl: `${O}/p`, status, chain: [], headers, timing: { ttfb: 1, total: 1 }, requests: 1 },
})
const GOOD = '<html lang="en"><head><title>Pricing</title><meta name="description" content="Plans and prices"></head><body><h1>Pricing</h1></body></html>'

describe('seo suite', () => {
  it('is quiet for a well-formed page', async () => {
    const s = setup()
    await seoSuite.onPage!(s.ctx, page(GOOD))
    expect(s.ids()).toEqual([])
  })

  it('reports each missing basic', async () => {
    const s = setup()
    await seoSuite.onPage!(s.ctx, page('<html><body><p>x</p></body></html>'))
    expect(s.ids()).toEqual(['seo.h1.missing', 'seo.lang.missing', 'seo.meta_description.missing', 'seo.title.missing'])
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
})
