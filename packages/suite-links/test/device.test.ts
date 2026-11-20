// Links by device, over HTTP (C06.10 slice b): phone, text and email links
// that cannot work, pages that answer one kind of browser with an error, and
// the files phones fetch to open links in an app.
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { crawl, HostThrottle, MemorySink } from '@webtrax/engine'
import { associationProblems, linksSuite, schemeProblem } from '../src'

describe('phone, text and email links', () => {
  it('accepts what a phone or mail app can use', () => {
    for (const ok of ['tel:+442079460000', 'tel:+44-20-7946-0000', 'tel:(020)7946.0000', 'tel:999', 'tel:+1-800-555-0100;ext=22', 'sms:+15550100', 'sms:', 'sms:+15550100?body=Hello%20there', 'sms:+15550100,+15550101',
      'mailto:ana@example.com', 'mailto:', 'mailto:ana@example.com?subject=Hi%20there&body=Text', 'mailto:ana@example.com,bo@example.org', 'MAILTO:Ana.B+tag@Example.co.uk', 'https://example.com/tel:nope', '/contact', '#top']) expect(schemeProblem(ok), ok).toBeNull()
  })
  it('says what is wrong with the rest', () => {
    expect(schemeProblem('tel:')).toBe('has no number')
    expect(schemeProblem('tel:020 7946 0000')).toBe('"020 7946 0000" has spaces in the number')
    expect(schemeProblem('tel:0800-CALL-NOW')).toBe('"0800-CALL-NOW" has letters in the number')
    expect(schemeProblem('tel:call us')).toBe('"call us" has letters in the number')
    expect(schemeProblem('tel:+1')).toBe('"+1" has too few digits')
    expect(schemeProblem('sms:+44/20')).toBe('"+44/20" is not a phone number')
    expect(schemeProblem('mailto:ana at example.com')).toBe('"ana at example.com" is not an email address')
    expect(schemeProblem('mailto:ana@example')).toBe('"ana@example" is not an email address')
    expect(schemeProblem('mailto:ana@example.com, nobody')).toBe('"nobody" is not an email address')
    expect(schemeProblem('mailto:%E0%A4%A')).toBe('is not a valid address (bad % encoding)')
  })
})

describe('app association files', () => {
  const json = 'application/json'
  it('accepts the documented shapes', () => {
    expect(associationProblems('apple', { body: '{"applinks":{"details":[{"appIDs":["ABCDE12345.com.example.app"],"components":[{"/":"/buy/*"}]}]}}', contentType: json, redirected: false })).toEqual([])
    expect(associationProblems('apple', { body: '{"webcredentials":{"apps":["ABCDE12345.com.example.app"]}}', contentType: 'application/json; charset=utf-8', redirected: false })).toEqual([])
    expect(associationProblems('android', { body: '[{"relation":["delegate_permission/common.handle_all_urls"],"target":{"namespace":"android_app","package_name":"com.example","sha256_cert_fingerprints":["AA:BB"]}}]', contentType: json, redirected: false })).toEqual([])
  })
  it('names each problem a phone would silently ignore the file for', () => {
    expect(associationProblems('apple', { body: '{"applinks":{"details":[]}}', contentType: 'text/plain', redirected: true })).toEqual(['is served through a redirect, which phones do not follow', 'is served as text/plain, not application/json'])
    expect(associationProblems('apple', { body: '{"applinks": {', contentType: json, redirected: false })).toEqual(['is not valid JSON'])
    expect(associationProblems('apple', { body: '{"hello":1}', contentType: json, redirected: false })).toEqual(['names no service (applinks, webcredentials, appclips)'])
    expect(associationProblems('apple', { body: '{"applinks":{}}', contentType: json, redirected: false })).toEqual(['has applinks without details'])
    expect(associationProblems('android', { body: '{"relation":[]}', contentType: json, redirected: false })).toEqual(['is not a JSON list of statements'])
    expect(associationProblems('android', { body: '[{"relation":"x","target":{}}]', contentType: undefined, redirected: false })).toEqual(['is served as no content type, not application/json', 'has a statement without a relation list and a target namespace'])
  })
})

const page = (title: string, body: string, head = '') => `<!doctype html><html lang="en"><head><title>${title}</title>${head}</head><body><h1>${title}</h1>${body}</body></html>`
let origin: string
let server: http.Server
let assetlinks: 'missing' | 'bad' | 'spa' = 'bad'
beforeAll(async () => {
  server = http.createServer((req, res) => {
    const ua = req.headers['user-agent'] ?? ''
    const phone = /Mobile/.test(ua)
    const browser = /Chrome\//.test(ua)
    const html = (status: number, body: string) => { res.writeHead(status, { 'content-type': 'text/html' }); res.end(body) }
    if (req.url === '/') return html(200, page('Home', '<a href="/phones">phones</a> <a href="/wall">wall</a> <a href="/fine">fine</a> <a href="/account">account</a> <a href="tel:0800 CALL NOW">Call us</a> <a href="tel:+442079460000">or here</a> <a href="mailto:hello at example.com">Email</a> <a href="mailto:hello@example.com">Email</a>', '<link rel="alternate" href="android-app://com.example/https/example.com/">'))
    // Phones are sent to a mobile address that no longer exists.
    if (req.url === '/phones') { if (phone) { res.writeHead(302, { location: '/m/phones' }); return res.end() } return html(200, page('Phones', '<p>For everyone.</p>')) }
    if (req.url === '/m/phones') return html(404, page('Not found', ''))
    // Automated checks are turned away; browsers are served.
    if (req.url === '/wall') return browser ? html(200, page('Wall', '<p>Hello.</p>')) : html(403, 'Forbidden')
    if (req.url === '/fine') return html(200, page('Fine', '<p>Same for all.</p>'))
    // Needs a sign-in, whoever asks.
    if (req.url === '/account') { res.writeHead(401, { 'content-type': 'text/html' }); return res.end('Sign in') }
    if (req.url === '/.well-known/assetlinks.json') {
      if (assetlinks === 'bad') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end('[{"relation": "oops"}]') }
      if (assetlinks === 'spa') return html(200, page('App', '<div id="app"></div>'))
      return html(404, 'Not found')
    }
    // The single-page app answers every other path with its shell, the Apple file included.
    if (req.url === '/.well-known/apple-app-site-association') return html(200, page('App', '<div id="app"></div>'))
    html(404, page('Not found', ''))
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})
afterAll(() => new Promise<void>((r) => server.close(() => r())))

const run = () => crawl(
  { spec_version: 1, job_id: 'd', target: { start_url: `${origin}/` }, scope: { allow_private: true }, limits: { per_host_rps: 50 }, suites: { links: { enabled: true } } },
  { sink: new MemorySink(), throttle: new HostThrottle(), suites: [linksSuite], options: { retryDelayMs: 1 } },
)
const of = (r: Awaited<ReturnType<typeof run>>, id: string) => r.findings.filter((f) => f.rule_id === id).map((f) => ({ url: f.url!.replace(origin, ''), severity: f.severity, title: f.title, evidence: f.evidence }))

describe('links by device on a site', () => {
  it('reports the page phones cannot reach, the bot wall as information, the broken phone and email links, and the bad app file', async () => {
    assetlinks = 'bad'
    const r = await run()
    expect(r.suiteErrors).toEqual([])
    const differs = of(r, 'links.device.response_differs')
    expect(differs).toEqual([
      { url: '/phones', severity: 'medium', title: 'Page fails for a phone browser', evidence: { webtrax: { status: 200 }, phone: { status: 404, final_url: `${origin}/m/phones` }, desktop: { status: 200 } } },
      { url: '/wall', severity: 'info', title: 'Link answers browsers but refuses Webtrax', evidence: { webtrax: { status: 403 }, desktop: { status: 200 }, note: expect.stringContaining('probably not broken') } },
    ])
    // The sign-in page is not broken, and neither is the bot wall: one line of information each, and no broken link.
    expect(of(r, 'links.unverified')).toEqual([{ url: '/account', severity: 'info', title: 'Link asks for a sign-in', evidence: { status: 401, internal: true } }])
    expect(r.findings.filter((f) => f.rule_id.startsWith('links.broken'))).toEqual([])
    expect(r.summary.links.broken).toBe(0)
    expect(of(r, 'links.scheme.invalid').map((f) => [f.url, f.title, f.evidence.href])).toEqual([
      ['/', 'tel: link "0800 CALL NOW" has letters in the number', 'tel:0800 CALL NOW'],
      ['/', 'mailto: link "hello at example.com" is not an email address', 'mailto:hello at example.com'],
    ])
    // The Android file is there and wrong; the Apple path only returns the app's HTML shell, which declares nothing.
    expect(of(r, 'links.app.association_invalid')).toEqual([{ url: '/.well-known/assetlinks.json', severity: 'medium', title: 'assetlinks.json has a statement without a relation list and a target namespace', evidence: { problems: ['has a statement without a relation list and a target namespace'] } }])
  }, 60_000)

  it('reports a missing Android file only because a page declares an Android app link', async () => {
    for (const state of ['missing', 'spa'] as const) {
      assetlinks = state
      const found = of(await run(), 'links.app.association_invalid')
      expect(found).toHaveLength(1)
      expect(found[0]).toMatchObject({ url: '/.well-known/assetlinks.json', title: 'Pages declare an Android app link, and assetlinks.json is missing', evidence: { declared_on: `${origin}/` } })
    }
  }, 60_000)
})
