// Results a customer can trust (the v2 review's V2-COR-01 to V2-COR-06): a run
// says when it did not see everything, a check that did not run is not a
// clean result, and a target that turned the check away is not broken.
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { RuleMeta } from '@webtrax/protocol'
import { couldNotVerify, crawl, HostThrottle, isBrokenOutcome, linkProblem, MemorySink, type CheckSuite } from '../src'

const page = (title: string, body: string) => `<!doctype html><html lang="en"><title>${title}</title><body><h1>${title}</h1>${body}</body></html>`
let origin: string
let server: http.Server
let headInFlight = 0
let headPeak = 0
const requests: string[] = []
beforeAll(async () => {
  server = http.createServer((req, res) => {
    requests.push(`${req.method} ${req.url}`)
    const html = (status: number, body: string) => { res.writeHead(status, { 'content-type': 'text/html' }); res.end(req.method === 'HEAD' ? '' : body) }
    const url = req.url ?? '/'
    if (url === '/') return html(200, page('Home', '<a href="/a">a</a> <a href="/b">b</a> <a href="/c">c</a> <a href="/d">d</a>'))
    if (/^\/[abcd]$/.test(url)) return html(200, page(`Page ${url}`, `<a href="${url}/deep">deeper</a>`))
    if (/^\/[abcd]\/deep$/.test(url)) return html(200, page(`Deep ${url}`, '<p>x</p>'))
    // A page whose links answer HEAD badly and GET well, or turn the check away.
    if (url === '/links') return html(200, page('Links', '<a href="/x/head-500.pdf">1</a> <a href="/x/head-reset.pdf">2</a> <a href="/x/login.pdf">3</a> <a href="/x/forbidden.pdf">4</a> <a href="/x/wall.pdf">5</a> <a href="/x/gone.pdf">6</a> <a href="/x/broken.pdf">7</a>'))
    if (url === '/x/head-500.pdf') { if (req.method === 'HEAD') { res.writeHead(500); return res.end() } res.writeHead(200, { 'content-type': 'application/pdf' }); return res.end('%PDF') }
    if (url === '/x/head-reset.pdf') { if (req.method === 'HEAD') return req.socket.destroy(); res.writeHead(200, { 'content-type': 'application/pdf' }); return res.end('%PDF') }
    if (url === '/x/login.pdf') { res.writeHead(401); return res.end() }
    if (url === '/x/forbidden.pdf') { res.writeHead(403); return res.end() }
    if (url === '/x/wall.pdf') { res.writeHead(999); return res.end() }
    if (url === '/x/gone.pdf') { res.writeHead(404); return res.end() }
    if (url === '/x/broken.pdf') { res.writeHead(500); return res.end() }
    // Forty links to files, each slow to answer, to see how many are asked for at once.
    if (url === '/many') return html(200, page('Many', Array.from({ length: 40 }, (_, i) => `<a href="/f/${i}.pdf">${i}</a>`).join(' ')))
    if (url.startsWith('/f/')) {
      headInFlight += 1
      headPeak = Math.max(headPeak, headInFlight)
      return setTimeout(() => { headInFlight -= 1; res.writeHead(200, { 'content-type': 'application/pdf' }); res.end() }, 40)
    }
    html(404, page('Not found', ''))
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})
afterAll(() => new Promise<void>((r) => server.close(() => r())))

const spec = (start: string, limits: Record<string, number> = {}, suites: Record<string, { enabled: boolean }> = {}) =>
  ({ spec_version: 1 as const, job_id: 't', target: { start_url: `${origin}${start}` }, scope: { allow_private: true }, limits: { per_host_rps: 50, ...limits }, suites })
const deps = (extra: object = {}) => ({ sink: new MemorySink(), throttle: new HostThrottle(), options: { retryDelayMs: 1 }, ...extra })
const rule: RuleMeta = { id: 'seo.test', suite: 'seo', title: 'Test', version: 1, severity: 'low', why: 'w', fix: 'f', docs_slug: 'x', tags: [] }

describe('a crawl that did not see everything says so (V2-COR-02)', () => {
  it('is partial with page_limit when pages were left out, and lists what it did reach', async () => {
    const r = await crawl(spec('/', { max_pages: 3 }), deps())
    expect(r.summary).toMatchObject({ status: 'partial', stop_reason: 'page_limit', pages: { crawled: 3 } })
    // The pages it crawled, and the ones over the limit that it still checked as links.
    expect(r.reached.all.map((u) => u.replace(origin, '')).sort()).toEqual(['/', '/a', '/a/deep', '/b', '/b/deep', '/c', '/d'])
  })

  it('is partial with depth_limit when links went deeper than it may follow', async () => {
    const r = await crawl(spec('/', { max_depth: 1 }), deps())
    expect(r.summary).toMatchObject({ status: 'partial', stop_reason: 'depth_limit', pages: { crawled: 5 } })
  })

  it('is completed when it followed everything', async () => {
    const r = await crawl(spec('/'), deps())
    expect(r.summary.status).toBe('completed')
    expect(r.summary.stop_reason).toBeUndefined()
    expect(r.summary.pages.crawled).toBe(9)
  })
})

describe('a link is broken only when it is (V2-COR-03, V2-COR-04)', () => {
  it('confirms every failed HEAD with a GET, and does not call sign-in walls and refusals broken', async () => {
    requests.length = 0
    const r = await crawl(spec('/links'), deps())
    const link = (path: string) => r.site!.links.get(`${origin}${path}`)!
    // HEAD answered 500, or the connection was reset: the GET that followed was fine.
    expect(link('/x/head-500.pdf')).toMatchObject({ status: 200 })
    expect(link('/x/head-reset.pdf')).toMatchObject({ status: 200 })
    expect(requests).toContain('GET /x/head-500.pdf')
    expect(requests).toContain('GET /x/head-reset.pdf')
    for (const path of ['/x/login.pdf', '/x/forbidden.pdf', '/x/wall.pdf']) {
      expect(couldNotVerify(link(path)), path).toBe(true)
      expect(isBrokenOutcome(link(path)), path).toBe(false)
      expect(linkProblem(link(path)), path).toBeNull()
    }
    // Gone and failing on both HEAD and GET: broken.
    expect(linkProblem(link('/x/gone.pdf'))).toBe('http')
    expect(linkProblem(link('/x/broken.pdf'))).toBe('http')
    expect(couldNotVerify(link('/x/gone.pdf'))).toBe(false)
    expect(r.summary.links).toEqual({ checked: 7, broken: 2 })
  })
})

describe('link checks are bounded (V2-COR-05)', () => {
  it('runs a few at a time, and stops at the cap without calling the rest anything', async () => {
    headPeak = 0
    // The files are outside the crawl's scope, so each is a link to check, not a page to crawl.
    const many = { ...spec('/many'), scope: { allow_private: true, exclude: ['/f/'] }, limits: { per_host_rps: 50, concurrency: 16 } }
    const r = await crawl(many, deps({ options: { retryDelayMs: 1, linkCheckConcurrency: 4 } }))
    expect(headPeak).toBeGreaterThan(1)
    expect(headPeak).toBeLessThanOrEqual(4)
    expect(r.summary.links.checked).toBe(40)
    const capped = await crawl(many, deps({ options: { retryDelayMs: 1, maxLinkChecks: 10 } }))
    expect(capped.summary.links).toEqual({ checked: 10, broken: 0 })
    expect(capped.site!.linksNotChecked).toBe(30)
  })
})

describe('a check that did not run is not a clean result (V2-COR-01)', () => {
  it('marks a suite whose hook threw as incomplete, and one that never got a browser page as skipped', async () => {
    const throws: CheckSuite = { id: 'seo', version: '1', requires: ['http'], rules: [rule], onPage(_c, p) { if (p.url.endsWith('/b')) throw new Error('boom') } }
    const fine: CheckSuite = { id: 'links', version: '1', requires: ['http'], rules: [] }
    const browser: CheckSuite = { id: 'a11y', version: '1', requires: ['http', 'browser'], rules: [], onBrowserPage() {} }
    // The time budget runs out at once, so the browser stage never starts.
    const r = await crawl(spec('/', {}, { seo: { enabled: true }, links: { enabled: true }, a11y: { enabled: true } }), deps({ suites: [throws, fine, browser], options: { retryDelayMs: 1, timeBudgetMs: 400, drainMs: 2000 } }))
    const by = Object.fromEntries(r.summary.suites.map((s) => [s.id, s]))
    expect(by.links).toEqual({ id: 'links', version: '1', requires: ['http'] })
    expect(by.a11y).toMatchObject({ complete: false, skipped: true })
    if (r.suiteErrors.some((e) => e.suite === 'seo')) expect(by.seo).toMatchObject({ complete: false })
    expect(by.seo!.skipped).toBeUndefined()
  }, 30_000)

  it('marks only the suite that threw', async () => {
    const throws: CheckSuite = { id: 'seo', version: '1', requires: ['http'], rules: [rule], onPage(_c, p) { if (p.url.endsWith('/b')) throw new Error('boom') } }
    const fine: CheckSuite = { id: 'links', version: '1', requires: ['http'], rules: [] }
    const r = await crawl(spec('/', {}, { seo: { enabled: true }, links: { enabled: true } }), deps({ suites: [throws, fine] }))
    expect(r.suiteErrors).toEqual([{ suite: 'seo', hook: 'onPage', url: `${origin}/b`, message: 'boom' }])
    expect(r.summary.suites).toEqual([{ id: 'seo', version: '1', requires: ['http'], complete: false }, { id: 'links', version: '1', requires: ['http'] }])
    expect(r.summary.status).toBe('completed')
  })
})

describe('one bad record costs that record, not the run (V2-COR-06)', () => {
  it('leaves out a finding the protocol refuses, notes it, and still finishes with a summary and the other findings', async () => {
    const long = `${origin}/q?x=${'a'.repeat(5000)}`
    const suite: CheckSuite = {
      id: 'seo', version: '1', requires: ['http'], rules: [rule],
      async onSite(ctx) {
        await ctx.emit({ rule_id: 'seo.test', url: long })
        await ctx.emit({ rule_id: 'seo.test', url: `${origin}/a` })
      },
    }
    const sink = new MemorySink()
    const r = await crawl(spec('/', {}, { seo: { enabled: true } }), { sink, throttle: new HostThrottle(), suites: [suite], options: { retryDelayMs: 1 } })
    expect(sink.of('summary')).toHaveLength(1)
    expect(sink.of('finding').map((f) => f.url)).toEqual([`${origin}/a`])
    expect(r.suiteErrors).toHaveLength(1)
    expect(r.suiteErrors[0]).toMatchObject({ suite: 'seo', hook: 'record' })
    // The suite's findings are no longer the whole picture.
    expect(r.summary.suites[0]).toMatchObject({ id: 'seo', complete: false })
  })

  it('does not crawl, check or record a URL too long to store', async () => {
    const long = `/long?x=${'b'.repeat(3000)}`
    const s2 = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end(page('Home', `<a href="${long}">long</a> <a href="/ok">ok</a>`)) })
    await new Promise<void>((r) => s2.listen(0, '127.0.0.1', r))
    const o2 = `http://127.0.0.1:${(s2.address() as AddressInfo).port}`
    try {
      const sink = new MemorySink()
      const r = await crawl({ spec_version: 1, job_id: 'l', target: { start_url: `${o2}/` }, scope: { allow_private: true }, limits: { per_host_rps: 50 } }, { sink, throttle: new HostThrottle(), options: { retryDelayMs: 1 } })
      expect(sink.of('summary')).toHaveLength(1)
      expect(r.suiteErrors).toEqual([])
      expect(sink.of('page').map((p) => p.url)).toEqual([`${o2}/`, `${o2}/ok`])
      expect([...r.site!.links.keys()].some((u) => u.includes('long'))).toBe(false)
    } finally {
      await new Promise<void>((res) => s2.close(() => res()))
    }
  })
})
