// ai_readiness.render.js_only: text that only appears after JavaScript runs,
// compared in Chromium with what the HTML holds. The suite never starts the
// browser by itself.
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { crawl, HostThrottle, MemorySink, parseHtml, type CheckSuite } from '@webtrax/engine'
import { aiSuite, httpText, jsOnly, RENDER_MIN_CHARS } from '../src'

const PARA = 'Webtrax checks every page of a website for broken links, slow pages and accessibility problems. '
const LONG = PARA.repeat(12)
const page = (title: string, body: string) => `<!doctype html><html lang="en"><head><title>${title}</title></head><body>${body}</body></html>`
const NAV = '<a href="/static">static</a> <a href="/late">late</a> <a href="/hybrid">hybrid</a> <a href="/tiny">tiny</a>'

let origin: string
let server: http.Server
beforeAll(async () => {
  server = http.createServer((req, res) => {
    if (req.url === '/data') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ text: LONG })) }
    res.writeHead(200, { 'content-type': 'text/html' })
    // The home page is a client-rendered shell: nothing but navigation until the script runs.
    if (req.url === '/') return res.end(page('Shell', `${NAV}<div id="app"></div><script>document.getElementById('app').textContent = ${JSON.stringify(LONG)}</script>`))
    if (req.url === '/static') return res.end(page('Static', `<main><h1>Static</h1><p>${LONG}</p></main><script>document.title = 'Still static'</script>`))
    // Content fetched after the load event.
    if (req.url === '/late') return res.end(page('Late', `<div id="app"></div><script>addEventListener('load', () => setTimeout(() => fetch('/data').then((r) => r.json()).then((d) => { document.getElementById('app').textContent = d.text }), 300))</script>`))
    // Half the text is in the HTML: script adds the rest, well under three times.
    if (req.url === '/hybrid') return res.end(page('Hybrid', `<p>${LONG}</p><div id="more"></div><script>document.getElementById('more').textContent = ${JSON.stringify(LONG)}</script>`))
    // A short page stays short: three times very little is still not content.
    if (req.url === '/tiny') return res.end(page('Tiny', `<div id="app"></div><script>document.getElementById('app').textContent = 'Signed out. Come back soon.'</script>`))
    res.end('')
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})
afterAll(() => new Promise<void>((r) => server.close(() => r())))

/** Stands in for a suite that requires the browser (a11y, performance), which is what makes the stage run. */
const needsBrowser: CheckSuite = { id: 'a11y', version: '0.0.0', requires: ['http', 'browser'], rules: [], onBrowserPage() {} }
const spec = (suites: Record<string, { enabled: boolean }>) => ({ spec_version: 1 as const, job_id: 'r', target: { start_url: `${origin}/` }, scope: { allow_private: true }, limits: { per_host_rps: 50 }, suites })

describe('text without JavaScript', () => {
  it('reads the body as a client without JavaScript would: noscript in, scripts, styles and templates out', () => {
    const { $ } = parseHtml(page('T', '<h1>Hello</h1>\n  <p>there</p><script>var hidden = "x"</script><style>p { color: red }</style><template><p>later</p></template>\n<noscript>Turn on JavaScript</noscript>'), 'https://site.example/')
    expect(httpText($)).toBe('Hello there Turn on JavaScript')
    expect(httpText(parseHtml('<html><head><title>No body text</title></head></html>', 'https://site.example/').$)).toBe('')
  })

  it('needs more than three times the text, and enough of it to be content', () => {
    expect(jsOnly(0, RENDER_MIN_CHARS)).toBe(true)
    expect(jsOnly(0, RENDER_MIN_CHARS - 1)).toBe(false)
    expect(jsOnly(400, 1200)).toBe(false)
    expect(jsOnly(400, 1201)).toBe(true)
    expect(jsOnly(2000, 2100)).toBe(false)
  })
})

describe('ai_readiness.render.js_only', () => {
  it('reports pages whose text arrives by script, at load or after it, and not static, hybrid or tiny ones', async () => {
    const r = await crawl(spec({ ai_readiness: { enabled: true }, a11y: { enabled: true } }), { sink: new MemorySink(), throttle: new HostThrottle(), suites: [aiSuite, needsBrowser] })
    expect(r.suiteErrors).toEqual([])
    const found = r.findings.filter((f) => f.rule_id === 'ai_readiness.render.js_only')
    expect(found.map((f) => f.url).sort()).toEqual([`${origin}/`, `${origin}/late`])
    const shell = found.find((f) => f.url === `${origin}/`)!
    expect(shell.severity).toBe('high')
    // The shell's HTML holds only its navigation.
    expect(shell.evidence).toMatchObject({ html_text_chars: 'static late hybrid tiny'.length, rendered_text_chars: expect.any(Number) })
    expect((shell.evidence as { rendered_text_chars: number }).rendered_text_chars).toBeGreaterThan(LONG.trim().length)
    expect(shell.title).toMatch(/^Only \d+% of the text is there without JavaScript$/)
    const late = found.find((f) => f.url === `${origin}/late`)!
    expect(late.evidence).toMatchObject({ html_text_chars: 0, ratio: null })
    expect(late.title).toBe('No text without JavaScript')
  }, 120_000)

  it('never starts a browser for itself: without a browser suite the check does not run', async () => {
    const r = await crawl(spec({ ai_readiness: { enabled: true } }), { sink: new MemorySink(), throttle: new HostThrottle(), suites: [aiSuite, needsBrowser] })
    expect(r.suiteErrors).toEqual([])
    expect(r.site?.browser).toBeUndefined()
    expect(r.findings.filter((f) => f.rule_id === 'ai_readiness.render.js_only')).toEqual([])
    // The HTTP checks still ran.
    expect(r.findings.some((f) => f.rule_id === 'ai_readiness.crawlers.policy')).toBe(true)
  }, 60_000)
})
