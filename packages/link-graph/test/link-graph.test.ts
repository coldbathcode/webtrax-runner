import { describe, expect, it } from 'vitest'
import { brokenLinkReach, buildLinkGraph, findPage, impactOfChange, KEY_PAGE_HINT, redirectDebt } from '../src/index'

const O = 'https://x.test'
const page = (p: string, depth: number, status = 200) => ({ url: O + p, final_url: O + p, status, depth })
const link = (p: string, from: string[], o: Partial<Parameters<typeof buildLinkGraph>[1][number]> = {}) => ({
  url: p.startsWith('http') ? p : O + p, internal: !p.startsWith('http'), outcome: 'ok' as const, status: 200, final_url: O + p, redirect_chain: [], from: from.map((f) => O + f), ...o,
})

// / -> /pricing -> /checkout ; / -> /blog -> /blog/a ; /blog/a carries a broken link; /pricing links /old (301 -> /checkout)
const pages = [page('/', 0), page('/pricing', 1), page('/blog', 1), page('/checkout', 2), page('/blog/a', 2), page('/gone', 3, 404)]
const links = [
  link('/', ['/pricing']), link('/pricing', ['/']), link('/blog', ['/']), link('/checkout', ['/pricing']), link('/blog/a', ['/blog']),
  link('/gone', ['/blog/a', '/checkout'], { outcome: 'broken', status: 404 }),
  link('/old', ['/pricing', '/blog'], { final_url: `${O}/checkout`, redirect_chain: [{ url: `${O}/old`, status: 301, ms: 40 }, { url: `${O}/old/`, status: 302, ms: 25 }] }),
  link('https://vendor.test/x', ['/blog'], { outcome: 'broken', status: null, error: 'dns_error' }),
  link('https://vendor.test/ok', ['/blog']),
]
const g = buildLinkGraph(pages, links, { origin: O, start: `${O}/`, partial: false })

describe('buildLinkGraph', () => {
  it('links pages by index once per pair, and keeps only broken and redirected targets', () => {
    expect(g.links).toContainEqual([0, 1])
    expect(g.links).toContainEqual([1, 0])
    expect(g.links.filter(([a, b]) => a === 4 && b === 5)).toHaveLength(1)
    expect(g.targets!.map((t) => t.url).sort()).toEqual([`${O}/gone`, `${O}/old`, 'https://vendor.test/x'].sort())
    expect(g.targets![0]!.outcome).toBe('broken')
  })
  it('finds a page with or without its trailing slash', () => {
    expect(findPage(g, '/blog/')).toBe(2)
    expect(findPage(g, `${O}/pricing`)).toBe(1)
    expect(findPage(g, '/nope')).toBe(-1)
  })
})

describe('impactOfChange', () => {
  it('names what links to a page and what would be cut off', () => {
    const r = impactOfChange(g, ['/pricing', '/blog'])
    const p = r.results[0]!
    if (!p.found) throw new Error()
    expect(p.linked_from_pages.pages).toEqual(['/'])
    expect(p.cut_off_if_removed.pages).toEqual(['/checkout'])
    expect(r.together?.cut_off_if_removed.pages).toEqual(['/checkout', '/blog/a', '/gone'])
  })
})

describe('redirectDebt', () => {
  it('lists internal redirects with each hop timed and the address to use', () => {
    const d = redirectDebt(g)
    if (!d.available) throw new Error()
    expect(d.redirects).toEqual([expect.objectContaining({ address: '/old', redirects_to: '/checkout', hops: 2, statuses: [301, 302], redirect_ms: 65, permanent: false, linked_from: 2, pages: ['/pricing', '/blog'] })])
    expect(d.totals).toEqual({ addresses: 1, links: 2, pages_carrying: 2, median_hop_ms: 33 })
  })
  it('says when a map has no targets', () => {
    expect(redirectDebt({ ...g, targets: null })).toMatchObject({ available: false })
  })
})

describe('brokenLinkReach', () => {
  it('escalates a broken link one click from a key page over one with more pages elsewhere', () => {
    const r = brokenLinkReach(g, { keyPages: ['/pricing', '/nowhere'] })
    if (!r.available) throw new Error()
    expect(r.key_pages).toEqual([{ key_page: '/pricing', found: true, path: '/pricing', clicks_from_start: 1 }, { key_page: '/nowhere', found: false }])
    expect(r.links[0]).toMatchObject({ target: '/gone', escalated: true, clicks_from_key_page: 1, key_pages: [{ key_page: '/pricing', how: 'one_click' }] })
    expect(r.links[1]).toMatchObject({ target: 'https://vendor.test/x', escalated: false, error: 'dns_error' })
  })
  it('suggests key pages from their paths when none are set', () => {
    const r = brokenLinkReach(g)
    if (!r.available) throw new Error()
    expect(r.suggested_key_pages).toEqual(['/pricing', '/checkout'])
    expect(KEY_PAGE_HINT.test('/en-gb/sign-up')).toBe(true)
    expect(KEY_PAGE_HINT.test('/blog/pricing-thoughts')).toBe(false)
  })
})
