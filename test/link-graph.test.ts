// The link graph of a run (C06.9 slice d): the engine's `link` records on the
// fixture site, and what @webtrax/link-graph reads from them. The cloud's
// side of "the same answer from the hosted and local MCP" is in
// the cloud worker's parity test.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { crawl, HostThrottle, MemorySink } from '@webtrax/engine'
import { brokenLinkReach, graphFromRun, impactOfChange, redirectDebt, type LinkGraph } from '@webtrax/link-graph'
import { linksSuite } from '@webtrax/suite-links'
import type { LinkRecord } from '@webtrax/protocol'
import { startFixtureSite } from '../fixtures/site/server.mjs'

let fixture: Awaited<ReturnType<typeof startFixtureSite>>
let sink: MemorySink
let graph: LinkGraph
const path = (u: string) => u.replace(fixture.origin, '') || '/'

beforeAll(async () => {
  fixture = await startFixtureSite()
  sink = new MemorySink()
  await crawl(
    { spec_version: 1, job_id: 'links', target: { start_url: `${fixture.origin}/` }, scope: { allow_private: true, check_external: true }, limits: { per_host_rps: 50, concurrency: 4 }, suites: { links: { enabled: true } } },
    { sink, throttle: new HostThrottle(), suites: [linksSuite], options: { retryDelayMs: 5 } },
  )
  graph = graphFromRun(sink.records)!
})
afterAll(() => fixture.close())

const link = (p: string): LinkRecord => sink.of('link').find((l) => path(l.url) === p)!

describe('link records', () => {
  it('come after the findings and before the summary, one per target', () => {
    const types = sink.records.map((r) => r.type)
    expect(types.indexOf('link')).toBeGreaterThan(types.lastIndexOf('finding'))
    expect(types.lastIndexOf('link')).toBe(types.length - 2)
    const urls = sink.of('link').map((l) => l.url)
    expect(new Set(urls).size).toBe(urls.length)
  })

  it('name every page that links to a broken target', () => {
    expect(link('/missing')).toMatchObject({ internal: true, outcome: 'broken', status: 404 })
    expect(link('/missing').from.map(path).sort()).toEqual(['/', '/blog/post-2'])
    expect(sink.of('link').find((l) => l.url === `${fixture.externalOrigin}/external-missing`)).toMatchObject({ internal: false, outcome: 'broken', from: [`${fixture.origin}/`] })
  })

  it('follow a redirect to a known page through to it, with each hop timed', () => {
    const old = link('/old-page')
    expect(old).toMatchObject({ outcome: 'ok', status: 200, final_url: `${fixture.origin}/about` })
    expect(old.redirect_chain).toHaveLength(1)
    expect(old.redirect_chain[0]).toMatchObject({ status: 301 })
    expect(old.redirect_chain[0]!.ms).toBeGreaterThanOrEqual(0)
  })

  it('say robots.txt kept a target unrequested, and list sitemap sources', () => {
    expect(link('/private/secret')).toMatchObject({ via: 'skipped', outcome: 'skipped' })
    expect(link('/gone-from-sitemap')).toMatchObject({ outcome: 'broken', from: [] })
    expect(link('/gone-from-sitemap').sitemaps?.map(path)).toEqual(['/sitemap.xml'])
  })
})

describe('impact_of_change from a run', () => {
  it('returns every page that links to the target, and what removing it cuts off', () => {
    const r = impactOfChange(graph, ['/blog']).results[0]!
    expect(r).toMatchObject({ found: true, is_start_page: false })
    if (!r.found) throw new Error('not found')
    expect([...r.linked_from_pages.pages].sort()).toEqual(['/', '/about'])
    // /server-error answers 500 but is still a page the crawl reached only through /blog.
    expect(r.cut_off_if_removed.pages).toEqual(['/blog/post-1', '/blog/post-2', '/server-error'])
  })
})

describe('redirect debt', () => {
  it('lists the internal link through a redirect with the address to use instead', () => {
    const d = redirectDebt(graph)
    if (!d.available) throw new Error('no targets')
    expect(d.redirects).toHaveLength(1)
    expect(d.redirects[0]).toMatchObject({ address: '/old-page', redirects_to: '/about', hops: 1, statuses: [301], permanent: true, linked_from: 1, pages: ['/'] })
    expect(d.redirects[0]!.redirect_ms).toBeGreaterThanOrEqual(0)
  })
})

describe('broken links by reach', () => {
  it('escalate links on a key page and on the route to it, and rank them first', () => {
    const r = brokenLinkReach(graph, { keyPages: ['/blog/post-2'] })
    if (!r.available) throw new Error('no targets')
    expect(r.key_pages).toEqual([{ key_page: '/blog/post-2', found: true, path: '/blog/post-2', clicks_from_start: 2 }])
    const by = Object.fromEntries(r.links.map((l) => [l.target.replace(fixture.externalOrigin, 'EXT'), l]))
    expect(by['/missing']).toMatchObject({ linked_from: 2, clicks_from_start: 0, escalated: true, key_pages: [{ key_page: '/blog/post-2', how: 'on_page' }] })
    expect(by['/server-error']).toMatchObject({ linked_from: 1, clicks_from_start: 1, escalated: true, key_pages: [{ how: 'on_route' }] })
    expect(r.links[0]!.target).toBe('/missing')
    // A sitemap entry is not a link a visitor follows.
    expect(by['/gone-from-sitemap']).toBeUndefined()
  })

  it('escalate nothing and suggest key pages when none are set', () => {
    const r = brokenLinkReach(graph)
    if (!r.available) throw new Error('no targets')
    expect(r.totals.escalated).toBe(0)
    expect(r.suggested_key_pages).toEqual([])
    expect(r.links[0]).toMatchObject({ target: '/missing', linked_from: 2 })
  })
})
