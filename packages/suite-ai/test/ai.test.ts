import { describe, expect, it } from 'vitest'
import { ALLOW_ALL, parseHtml, type CrawledPage, type FindingInput, type SiteState, type SuiteCtx } from '@webtrax/engine'
import type { Outcome } from '@webtrax/engine'
import { JobSpec, type PageRecord } from '@webtrax/protocol'
import { AI_CRAWLERS, aiSuite, checkLlmsTxt } from '../src'

const O = 'https://site.example'
const answer = (url: string, status: number | null, body = '', contentType = 'text/plain', extra: Partial<Outcome> = {}): Outcome =>
  ({ url, finalUrl: url, status, chain: [], body, contentType, timing: { ttfb: 1, total: 1 }, requests: 1, ...extra })

function setup(files: Record<string, Outcome | undefined>, live: Record<string, number> = {}) {
  const emitted: FindingInput[] = []
  const fetched: string[] = []
  const ctx: SuiteCtx = {
    spec: JobSpec.parse({ spec_version: 1, job_id: 'x', target: { start_url: `${O}/` } }), config: {}, origin: O, startUrl: `${O}/`, requestedStartUrl: `${O}/`,
    emit: async (f) => { emitted.push(f) }, metric: async () => {},
    request: async (url) => { fetched.push(url); return answer(url, live[url] ?? 404, '', 'text/html') },
    requestAs: async () => { throw new Error('the AI suite asks as no device') },
    text: async (url) => { fetched.push(url); return files[url] ?? answer(url, 404, 'Not found') },
  }
  const by = (id: string) => emitted.filter((f) => f.rule_id === id)
  return { ctx, emitted, fetched, by, ids: () => [...new Set(emitted.map((f) => f.rule_id))].sort() }
}
const record = (url: string, status = 200): PageRecord => ({ type: 'page', url, final_url: url, status, redirect_chain: [], depth: 0 })
const site = (pages: PageRecord[] = [record(`${O}/`)]): SiteState => ({ origin: O, startUrl: `${O}/`, requestedStartUrl: `${O}/`, robots: ALLOW_ALL, pages: new Map(pages.map((p) => [p.url, p])), links: new Map(), edges: [], sitemapUrls: [] })
const page = (html: string, url = `${O}/`): CrawledPage => ({
  url, depth: 0, doc: parseHtml(html, url), outcome: { url, finalUrl: url, status: 200, chain: [], headers: {}, timing: { ttfb: 1, total: 1 }, requests: 1 },
})
const LD = '<script type="application/ld+json">{"@type":"Organization","name":"Site"}</script>'
const LLMS = '# Site\n\n> What we do.\n\n## Docs\n\n- [Pricing](https://site.example/pricing): plans\n- [Guide](/guide): how to\n'

describe('llms.txt', () => {
  it('parses the proposal: title first, markdown links resolved against the file', () => {
    expect(checkLlmsTxt(LLMS, `${O}/llms.txt`)).toEqual({ problems: [], links: [`${O}/pricing`, `${O}/guide`] })
    expect(checkLlmsTxt('Site\n- no links here', `${O}/llms.txt`).problems).toEqual(['does not start with a "# Title" line', 'lists no pages as markdown links'])
    expect(checkLlmsTxt('<!doctype html><html>', `${O}/llms.txt`).problems).toEqual(['served as an HTML page, not markdown'])
  })

  it('missing, or the app\'s HTML served for every path, is reported; a good file with live links is not', async () => {
    const none = setup({})
    await aiSuite.onSite!(none.ctx, site())
    expect(none.by('ai_readiness.llms_txt.missing')).toHaveLength(1)
    const spa = setup({ [`${O}/llms.txt`]: answer(`${O}/llms.txt`, 200, '<div id="app"></div>', 'text/html; charset=utf-8') })
    await aiSuite.onSite!(spa.ctx, site())
    expect(spa.by('ai_readiness.llms_txt.invalid')[0]!.evidence).toMatchObject({ problems: ['served as an HTML page, not markdown'] })
    expect(spa.by('ai_readiness.llms_txt.missing')).toHaveLength(0)
    const good = setup({ [`${O}/llms.txt`]: answer(`${O}/llms.txt`, 200, LLMS) }, { [`${O}/guide`]: 200 })
    await aiSuite.onSite!(good.ctx, site([record(`${O}/`), record(`${O}/pricing`)]))
    expect(good.ids().filter((i) => i.startsWith('ai_readiness.llms'))).toEqual([])
    // Crawled pages are not fetched again; others once each.
    expect(good.fetched.filter((u) => u === `${O}/pricing`)).toEqual([])
    expect(good.fetched.filter((u) => u === `${O}/guide`)).toEqual([`${O}/guide`])
  })

  it('a linked page that does not answer, and a server error, are handled', async () => {
    const broken = setup({ [`${O}/llms.txt`]: answer(`${O}/llms.txt`, 200, LLMS) })
    await aiSuite.onSite!(broken.ctx, site([record(`${O}/`), record(`${O}/pricing`)]))
    expect(broken.by('ai_readiness.llms_txt.invalid')[0]!.evidence).toMatchObject({ problems: ['1 linked page does not answer'], broken: [{ url: `${O}/guide`, status: 404 }] })
    const down = setup({ [`${O}/llms.txt`]: answer(`${O}/llms.txt`, 503, '') })
    await aiSuite.onSite!(down.ctx, site())
    expect(down.ids().filter((i) => i.startsWith('ai_readiness.llms'))).toEqual([])
  })
})

describe('AI crawlers in robots.txt', () => {
  const run = async (robots: string | null) => {
    const s = setup(robots === null ? {} : { [`${O}/robots.txt`]: answer(`${O}/robots.txt`, 200, robots) })
    await aiSuite.onSite!(s.ctx, site())
    return s
  }
  it('no robots.txt allows every crawler: one info finding, nothing else', async () => {
    const s = await run(null)
    const p = s.by('ai_readiness.crawlers.policy')
    expect(p).toHaveLength(1)
    expect(p[0]).toMatchObject({ title: 'robots.txt allows every known AI crawler', evidence_key: 'all-allowed', evidence: { robots_txt: 'none' } })
    expect(Object.values(p[0]!.evidence!.crawlers as Record<string, string>).every((v) => v === 'allowed')).toBe(true)
    expect(s.by('ai_readiness.crawlers.inconsistent')).toHaveLength(0)
  })
  it('reads named groups and the wildcard, and keys the finding by the policy', async () => {
    const s = await run('User-agent: GPTBot\nDisallow: /\n\nUser-agent: CCBot\nDisallow: /\n\nUser-agent: *\nAllow: /\n')
    const p = s.by('ai_readiness.crawlers.policy')[0]!
    expect(p.evidence_key).toBe('GPTBot,CCBot')
    expect(p.title).toBe(`robots.txt blocks 2 of ${AI_CRAWLERS.length} known AI crawlers`)
    expect((p.evidence!.crawlers as Record<string, string>).ClaudeBot).toBe('allowed')
    const all = await run('User-agent: *\nDisallow: /\n')
    expect(all.by('ai_readiness.crawlers.policy')[0]!.title).toBe('robots.txt blocks every known AI crawler')
    expect(all.by('ai_readiness.crawlers.inconsistent')).toHaveLength(0)
  })
  it('flags a vendor whose search crawler and user agent are treated differently', async () => {
    const s = await run('User-agent: OAI-SearchBot\nDisallow: /\n\nUser-agent: Claude-User\nDisallow: /\n')
    expect(s.by('ai_readiness.crawlers.inconsistent').map((f) => [f.evidence_key, f.title])).toEqual([
      ['OpenAI', 'OpenAI: agent allowed, search blocked'],
      ['Anthropic', 'Anthropic: search allowed, agent blocked'],
    ])
  })
  it('an HTML page served as robots.txt counts as none', async () => {
    const s = setup({ [`${O}/robots.txt`]: answer(`${O}/robots.txt`, 200, '<div>\nUser-agent: *\nDisallow: /\n</div>', 'text/html') })
    await aiSuite.onSite!(s.ctx, site())
    expect(s.by('ai_readiness.crawlers.policy')[0]!.evidence_key).toBe('all-allowed')
  })
})

describe('structured data', () => {
  it('reports JSON-LD that does not parse, per page', async () => {
    const s = setup({})
    await aiSuite.onPage!(s.ctx, page(`<html><head>${LD}<script type="application/ld+json">{"@type": "Product",}</script></head></html>`))
    expect(s.by('ai_readiness.schema.invalid')).toHaveLength(1)
    expect(s.by('ai_readiness.schema.invalid')[0]!.evidence).toMatchObject({ blocks: 1 })
  })
  it('reports a site with no JSON-LD on any page, once, and not a site with some', async () => {
    const none = setup({})
    await aiSuite.onPage!(none.ctx, page('<p>a</p>'))
    await aiSuite.onPage!(none.ctx, page('<p>b</p>', `${O}/b`))
    await aiSuite.onSite!(none.ctx, site())
    expect(none.by('ai_readiness.schema.none')).toEqual([expect.objectContaining({ url: null, evidence: { pages_checked: 2 } })])
    const some = setup({})
    await aiSuite.onPage!(some.ctx, page('<p>a</p>'))
    await aiSuite.onPage!(some.ctx, page(`<html><head>${LD}</head></html>`, `${O}/b`))
    await aiSuite.onSite!(some.ctx, site())
    expect(some.by('ai_readiness.schema.none')).toHaveLength(0)
  })
})
