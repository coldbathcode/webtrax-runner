// Links by device, rendered (C06.10 slice c): a page linked only from a
// desktop-only menu, a link under a fixed banner, and a normal responsive
// menu that hides its links behind a button and must not be reported.
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { crawl, HostThrottle, MemorySink, type CheckSuite, type CrawlResult } from '@webtrax/engine'
import { linksSuite } from '../src'

const CSS = `<style>
  body { margin: 0; font: 16px sans-serif }
  .desk { display: flex; gap: 1rem } .burger { display: none }
  @media (max-width: 600px) { .desk { display: none } .burger { display: block } }
</style>`
const MENU_JS = `<script>
  const b = document.querySelector('.burger'), m = document.getElementById('m')
  b.addEventListener('click', () => { m.hidden = !m.hidden; b.setAttribute('aria-expanded', String(!m.hidden)) })
</script>`
/** `broken`: /desk-only is in the desktop menu only, and a cookie banner covers a link. Otherwise every link is in the phone menu too. */
const home = (broken: boolean) => `<!doctype html><html lang="en"><head><title>Home</title><meta name="viewport" content="width=device-width">${CSS}</head><body>
  <header>
    <nav class="desk"><a href="/about">About</a> <a href="/desk-only">Desk only</a> <a href="/list/3">Latest</a></nav>
    <button class="burger" aria-expanded="false" aria-controls="m">Menu</button>
    <nav id="m" hidden><a href="/about">About</a>${broken ? '' : ' <a href="/desk-only">Desk only</a>'}</nav>
  </header>
  <main><h1>Home</h1><p>Welcome.</p><a href="/list">Articles</a></main>
  <a href="/under" style="position:absolute;top:calc(100vh - 50px);left:20px">Under the banner</a>
  ${broken ? '<div id="cookie" class="banner" style="position:fixed;left:0;right:0;bottom:0;height:120px;background:#fff">We use cookies.</div>' : ''}
  ${MENU_JS}</body></html>`
const page = (t: string) => `<!doctype html><html lang="en"><head><title>${t}</title><meta name="viewport" content="width=device-width">${CSS}</head><body><h1>${t}</h1><a href="/">Home</a>${PAGER[t] ?? ''}</body></html>`
// Pagination: the numbers are for desktops; a phone gets "Next" on each page, which still reaches every page.
const NUMBERS = `<nav aria-label="Pages" class="desk"><a href="/list/2">2</a> <a href="/list/3">3</a></nav>`
const PAGER: Record<string, string> = { '/list': `${NUMBERS}<a href="/list/2">Next</a>`, '/list/2': `${NUMBERS}<a href="/list/3">Next</a>`, '/list/3': NUMBERS }

async function site(broken: boolean) {
  const server = http.createServer((req, res) => {
    res.writeHead(req.url === '/' || ['/about', '/desk-only', '/under', '/list', '/list/2', '/list/3'].includes(req.url ?? '') ? 200 : 404, { 'content-type': 'text/html' })
    res.end(req.url === '/' ? home(broken) : page(req.url ?? ''))
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  return { origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, close: () => new Promise<void>((r) => server.close(() => r())) }
}

// A browser suite that only loads pages, as a phone too, so the stage runs.
const loader: CheckSuite = { id: 'performance', version: '0.0.0', requires: ['browser'], rules: [], everyProfile: true, async onBrowserPage() {} }
const scan = (origin: string, profiles: ('desktop' | 'phone')[], extra?: number) => crawl(
  { spec_version: 1, job_id: 'r', target: { start_url: `${origin}/` }, scope: { allow_private: true }, limits: { per_host_rps: 50 }, browser: { profiles, ...(extra ? { extra_profile_pages: extra } : {}) }, suites: { links: { enabled: true }, performance: { enabled: true } } },
  { sink: new MemorySink(), throttle: new HostThrottle(), suites: [linksSuite, loader], options: { retryDelayMs: 1 } },
)
const device = (r: CrawlResult) => r.findings.filter((f) => f.rule_id.startsWith('links.device.'))

let bad: Awaited<ReturnType<typeof site>>
let good: Awaited<ReturnType<typeof site>>
beforeAll(async () => { [bad, good] = await Promise.all([site(true), site(false)]) })
afterAll(async () => { await bad.close(); await good.close() })

describe('links as visitors see them', () => {
  it('reports a page linked only from a desktop-only menu, and links under a fixed banner', async () => {
    const r = await scan(bad.origin, ['desktop', 'phone'])
    expect(r.suiteErrors).toEqual([])
    const home = r.site!.rendered!.find((x) => x.url === `${bad.origin}/` && x.profile === 'phone')!
    expect(home.menus_opened).toBeGreaterThan(0)
    expect(Object.fromEntries(home.links.map((l) => [l.url.replace(bad.origin, ''), l.reach]))).toMatchObject({ '/about': 'menu', '/desk-only': 'hidden', '/under': 'visible' })
    const found = device(r)
    expect(found.map((f) => [f.rule_id, f.url?.replace(bad.origin, ''), f.severity])).toEqual([
      ['links.device.unreachable_on_phone', '/desk-only', 'medium'],
      ['links.device.covered', '/', 'medium'],
    ])
    expect(found[0]).toMatchObject({ source_url: `${bad.origin}/`, evidence: { linked_at_desktop_from: ['/'], phone_pages_checked: 7, link_text: 'Desk only' } })
    expect(found[1]).toMatchObject({ title: '1 link covered by div#cookie.banner', evidence: { covered_by: 'div#cookie.banner', profiles: ['desktop', 'phone'], examples: [{ href: '/under', text: 'Under the banner' }] } })
  }, 120_000)

  it('stays quiet for page numbers a phone does not show when "Next" still gets there', async () => {
    const r = await scan(bad.origin, ['desktop', 'phone'])
    const list = r.site!.rendered!.find((x) => x.url === `${bad.origin}/list` && x.profile === 'phone')!
    expect(list.links.find((l) => l.url === `${bad.origin}/list/3`)?.reach).toBe('hidden')
    expect(device(r).map((f) => f.url)).not.toContain(`${bad.origin}/list/3`)
  }, 120_000)

  it('as hosted scans do, with only the home page loaded as a phone: the other pages\' links count as crawled', async () => {
    const r = await scan(bad.origin, ['desktop', 'phone'], 1)
    expect(r.site!.rendered!.filter((x) => x.profile === 'phone').map((x) => x.url)).toEqual([`${bad.origin}/`])
    expect(device(r).filter((f) => f.rule_id === 'links.device.unreachable_on_phone').map((f) => [f.url, f.evidence])).toEqual([
      [`${bad.origin}/desk-only`, { linked_at_desktop_from: ['/'], phone_pages_checked: 1, link_text: 'Desk only' }],
    ])
  }, 120_000)

  it('stays quiet for a responsive menu that holds every link', async () => {
    const r = await scan(good.origin, ['desktop', 'phone'])
    expect(r.suiteErrors).toEqual([])
    expect(device(r)).toEqual([])
  }, 120_000)

  it('says nothing about phones when no page was loaded as one', async () => {
    const r = await scan(bad.origin, ['desktop'])
    expect(device(r).map((f) => f.rule_id)).toEqual(['links.device.covered'])
  }, 120_000)
})
