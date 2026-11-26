import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ScopeDeniedError } from '@webtrax/net-guard'
import { parseNdjson } from '@webtrax/protocol'
import { describe, expect, it } from 'vitest'
import { classifyError, HostThrottle, siteOrigins, isBrokenOutcome, LocalSink, parseRobots, parseSitemap, retryAfterMs, robotsProductToken, type ThrottleClock } from '../src'
import { parseHtml } from '../src/html'

/** A clock where sleep advances time instantly, recording each start. */
function fakeClock() {
  let t = 0
  const clock: ThrottleClock = { now: () => t, sleep: async (ms) => { t += ms } }
  return { clock, advance: (ms: number) => { t += ms }, get now() { return t } }
}

describe('HostThrottle', () => {
  it('reserves slots synchronously, so concurrent callers are spaced (COR-09)', async () => {
    const sleeps: number[] = []
    const throttle = new HostThrottle({ now: () => 0, sleep: async (ms) => { sleeps.push(ms) } })
    // Three callers at the same instant: the first goes now, the others queue a full interval apart.
    await Promise.all([throttle.wait('a.test', 2), throttle.wait('a.test', 2), throttle.wait('a.test', 2), throttle.wait('b.test', 2)])
    expect(sleeps).toEqual([500, 1000])
  })

  it('uses the larger of 1/rps and Crawl-delay, capped at 30 s, per host', () => {
    const throttle = new HostThrottle(fakeClock().clock)
    throttle.setCrawlDelay('a.test', 5)
    throttle.setCrawlDelay('b.test', 600)
    expect(throttle.intervalMs('a.test', 2)).toBe(5000)
    expect(throttle.intervalMs('b.test', 2)).toBe(30_000)
    expect(throttle.intervalMs('c.test', 2)).toBe(500)
  })

  it('halves the rate per 429, up to 32x slower', () => {
    const throttle = new HostThrottle(fakeClock().clock)
    throttle.penalise('a.test')
    expect(throttle.intervalMs('a.test', 2)).toBe(1000)
    for (let i = 0; i < 10; i++) throttle.penalise('a.test')
    expect(throttle.intervalMs('a.test', 2)).toBe(16_000)
  })

  it('makes the second request wait one interval', async () => {
    const f = fakeClock()
    const throttle = new HostThrottle(f.clock)
    await throttle.wait('a.test', 2)
    const before = f.now
    await throttle.wait('a.test', 2)
    expect(f.now - before).toBe(500)
  })
})

describe('robots.txt', () => {
  it('matches the WebtraxBot product token, not "Mozilla" (v1 COR-27)', () => {
    expect(robotsProductToken('Mozilla/5.0 (compatible; WebtraxBot/1.0; +https://webtrax.dev/bot)')).toBe('WebtraxBot')
    expect(robotsProductToken('curl/8.0')).toBe('curl')
    expect(robotsProductToken('')).toBe('*')
  })

  it('applies the WebtraxBot group, its Crawl-delay and the Sitemap lines', () => {
    const r = parseRobots('https://s.test/robots.txt', 'User-agent: WebtraxBot\nDisallow: /private\nCrawl-delay: 2\n\nUser-agent: *\nDisallow: /\n\nSitemap: https://s.test/sm.xml\n', 'Mozilla/5.0 (compatible; WebtraxBot/1.0)')
    expect(r.isAllowed('https://s.test/private/x')).toBe(false)
    expect(r.isAllowed('https://s.test/public')).toBe(true)
    expect(r.crawlDelay()).toBe(2)
    expect(r.sitemaps()).toEqual(['https://s.test/sm.xml'])
  })

  it('allows everything when robots.txt is empty', () => {
    expect(parseRobots('https://s.test/robots.txt', '', 'WebtraxBot').isAllowed('https://s.test/any')).toBe(true)
  })
})

describe('sitemaps', () => {
  it('extracts and decodes locs, and tells an index from a urlset', () => {
    expect(parseSitemap('<urlset><url><loc> https://s.test/a?x=1&amp;y=2 </loc></url><url><loc>https://s.test/a?x=1&amp;y=2</loc></url></urlset>'))
      .toEqual({ isIndex: false, locs: ['https://s.test/a?x=1&y=2'] })
    expect(parseSitemap('<sitemapindex><sitemap><loc>https://s.test/s1.xml</loc></sitemap></sitemapindex>').isIndex).toBe(true)
  })
})

describe('classification', () => {
  const failed = (code: string) => Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error(code), { code }) })
  it('maps failures to protocol fetch errors', () => {
    expect(classifyError(new ScopeDeniedError('private_address', '10.0.0.1'))).toBe('blocked_by_scope')
    expect(classifyError(failed('ENOTFOUND'))).toBe('dns_error')
    expect(classifyError(failed('UND_ERR_CONNECT_TIMEOUT'))).toBe('timeout')
    expect(classifyError(Object.assign(new Error('aborted'), { name: 'TimeoutError' }))).toBe('timeout')
    expect(classifyError(failed('CERT_HAS_EXPIRED'))).toBe('tls_error')
    expect(classifyError(failed('ECONNREFUSED'))).toBe('connection_error')
  })

  it('reads Retry-After as seconds or a date, capped', () => {
    expect(retryAfterMs('3', 0)).toBe(3000)
    expect(retryAfterMs('9999', 0)).toBe(120_000)
    expect(retryAfterMs(new Date(10_000).toUTCString(), 0)).toBe(10_000)
    expect(retryAfterMs(null, 0)).toBe(5000)
    expect(retryAfterMs('soon', 0)).toBe(5000)
  })

  it('never counts rate limiting or robots skips as broken', () => {
    expect(isBrokenOutcome({ status: 404 })).toBe(true)
    expect(isBrokenOutcome({ status: 429 })).toBe(false)
    expect(isBrokenOutcome({ status: null, error: 'rate_limited' })).toBe(false)
    expect(isBrokenOutcome({ status: null, error: 'robots_disallowed' })).toBe(false)
    expect(isBrokenOutcome({ status: null, error: 'dns_error' })).toBe(true)
    expect(isBrokenOutcome({ status: 301 })).toBe(false)
  })
})

describe('LocalSink', () => {
  it('writes valid NDJSON under .webtrax/runs/<timestamp>/', async () => {
    const root = mkdtempSync(join(tmpdir(), 'webtrax-sink-'))
    try {
      const sink = new LocalSink(root, new Date('2026-11-16T10:00:00Z'))
      sink.write({ type: 'page', url: 'https://s.test/', final_url: 'https://s.test/', status: 200, depth: 0, redirect_chain: [] })
      await sink.close()
      expect(sink.file).toContain(join('.webtrax', 'runs', '2026-11-16T10-00-00-000Z', 'run.ndjson'))
      expect(parseNdjson(readFileSync(sink.file, 'utf8'))).toMatchObject([{ ok: true, record: { type: 'page' } }])
      expect(() => sink.write({ type: 'page' } as never)).toThrow()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('the layout skeleton (template_key)', () => {
  const page = (body: string) => parseHtml(`<!doctype html><html><head><title>t</title></head><body class="postid-42 home">${body}</body></html>`, 'https://shop.example.com/x').templateKey
  const post = (title: string, paragraphs: number, id: number) => `<header class="site-header"><nav><a href="/">Home</a><a href="/blog">Blog</a></nav></header>
    <main class="post post-${id}"><h1>${title}</h1>${'<p>Some words.</p>'.repeat(paragraphs)}<script>var id=${id}</script></main><footer class="site-footer"><p>© Shop</p></footer>`
  const listing = (cards: number) => `<header class="site-header"><nav><a href="/">Home</a></nav></header>
    <main class="listing"><h1>Blog</h1><ul class="cards">${'<li class="card"><a href="/p">Post</a></li>'.repeat(cards)}</ul></main><footer class="site-footer"><p>© Shop</p></footer>`

  it('is the same for pages built from one template, whatever their text, length or ids', () => {
    expect(page(post('First', 2, 1))).toMatch(/^[0-9a-f]{16}$/)
    expect(page(post('Another one entirely', 40, 977))).toBe(page(post('First', 2, 1)))
    expect(page(listing(3))).toBe(page(listing(60)))
  })

  it('differs between templates, and is absent for an empty body', () => {
    expect(page(listing(3))).not.toBe(page(post('First', 2, 1)))
    expect(page(post('First', 2, 1).replace('class="post', 'class="product'))).not.toBe(page(post('First', 2, 1)))
    expect(page('')).toBeUndefined()
    expect(page('just text')).toBeUndefined()
  })
})


describe('siteOrigins: where a job\'s auth headers may go', () => {
  it('is the start origin and its www. twin, never down to http', () => {
    expect(siteOrigins('https://shop.example.com/pricing')).toEqual(['https://shop.example.com', 'https://www.shop.example.com'])
    expect(siteOrigins('https://www.example.com/')).toEqual(['https://www.example.com', 'https://example.com'])
    expect(siteOrigins('https://example.com:8443/')).toEqual(['https://example.com:8443', 'https://www.example.com:8443'])
  })
  it('adds the https form of an http start, as a redirect to it is the same site', () => {
    expect(siteOrigins('http://example.com/')).toEqual(['http://example.com', 'http://www.example.com', 'https://example.com', 'https://www.example.com'])
  })
  it('gives an address no www. form', () => {
    expect(siteOrigins('http://127.0.0.1:4000/')).toEqual(['http://127.0.0.1:4000', 'https://127.0.0.1'])
    expect(siteOrigins('http://localhost:4000/')).toEqual(['http://localhost:4000', 'https://localhost'])
  })
})

describe('engine user agents (C06.10 slice d)', () => {
  it('are each browser\'s own string with the Webtrax token, as webtrax.dev/bot lists them', async () => {
    const { webkitDesktopUserAgent, webkitPhoneUserAgent, firefoxUserAgent, profileUserAgent, PROFILES } = await import('../src')
    const token = '(compatible; WebtraxBot/1.0; +https://webtrax.dev/bot)'
    expect(webkitDesktopUserAgent('26.0')).toBe(`Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15 ${token}`)
    expect(webkitPhoneUserAgent('26.0')).toBe(`Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1 ${token}`)
    expect(firefoxUserAgent('144.0.2')).toBe(`Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:144.0) Gecko/20100101 Firefox/144.0 ${token}`)
    // A user agent the spec sets is sent as it is; Chromium's desktop sends the bot's own.
    expect(profileUserAgent(PROFILES['firefox-desktop'], '144.0', 'Custom/1', 'Bot/1')).toBe('Custom/1')
    expect(profileUserAgent(PROFILES.desktop, '143.0', undefined, 'Bot/1')).toBe('Bot/1')
  })
})
