// The browser fixture (C06.8's last gap): one page per browser-stage rule,
// loaded in real Chromium, and a clean twin that must give no browser-stage
// findings. The HTTP rules have their fixture in rules.mjs, on made-up hosts
// behind an injected fetch; a browser cannot be pointed at those without
// test hooks in the egress proxy, so these sites are real local servers and
// the test compares rules and paths, not fingerprints (which carry the port).
//
//   measure   desktop: accessibility (a few of axe's rules), speed (each of the
//             four performance rules, made slow on purpose and by more than
//             timing noise) and text that only JavaScript writes
//   device    desktop and phone: a page linked only from a desktop menu, and a
//             link a fixed banner covers
//
// Each site has a clean twin: the same kinds of pages, done right.

import http from 'node:http'
import { prose } from './rules.mjs'

// A 1x1 PNG.
const PIXEL = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')
/** Past performance.page_weight's 3 MB and short of its 6 MB "poor". */
const HEAVY_BYTES = 3.5 * 1024 * 1024
/** The stylesheet that holds up the first paint: past LCP's 2.5 s, short of its 4 s "poor" with room for a slow machine. */
export const SLOW_CSS_MS = 3_000
/** Past TTFB's 800 ms, short of its 1.8 s "poor". */
export const SLOW_HTML_MS = 1_100

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;')
const STYLE = '<style>body{font:16px/1.5 sans-serif;color:#111;background:#fff;margin:0 auto;max-width:44rem;padding:0 1rem}</style>'

/** An accessible page: language, title, viewport, a main landmark with one h1, readable text. */
function page(o) {
  return `<!doctype html><html${o.lang === null ? '' : ' lang="en"'}><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">` +
    `<title>${esc(o.title)}</title>${STYLE}${o.head ?? ''}</head><body>${o.header ?? ''}<main><h1>${esc(o.title)}</h1>${o.main ?? `<p>${prose(o.seed ?? o.title)}</p>`}${o.extra ?? ''}</main>${o.after ?? ''}</body></html>`
}

/** The browser-stage rules each have a page at /defects/<rule_id>: its own finding and no other. */
export const MEASURE_DEFECTS = {
  'a11y.image_alt': { extra: '<p><img src="/pixel.png" width="40" height="40"></p>' },
  'a11y.label': { extra: '<form action="/search"><input type="text" name="q"><button type="submit">Search</button></form>' },
  'a11y.color_contrast': { extra: '<p style="color:#c8c8c8">Pale grey text that is hard to read on white.</p>' },
  'a11y.link_name': { extra: '<p><a href="/"><img src="/pixel.png" width="20" height="20" alt=""></a></p>' },
  'a11y.button_name': { extra: '<p><button type="button"></button></p>' },
  'a11y.html_has_lang': { lang: null },
  'performance.lcp.slow': { head: '<link rel="stylesheet" href="/defects/performance.lcp.slow/slow.css">' },
  'performance.cls.high': {
    // After the first paint, a 500 px block lands above the text and pushes it down.
    after: '<script>setTimeout(() => { const d = document.createElement("div"); d.style.height = "500px"; d.style.background = "#eef"; document.querySelector("main").prepend(d) }, 150)</script>',
  },
  'performance.ttfb.slow': {},
  // A script, which Chromium downloads in full (an image it cannot decode it stops downloading).
  'performance.page_weight': { after: '<script src="/defects/performance.page_weight/heavy.js"></script>' },
  'ai_readiness.render.js_only': {
    main: '<div id="app"></div>',
    after: `<script>document.getElementById("app").innerHTML = ${JSON.stringify(`<p>${prose('render.js_only', 120)}</p>`)}</script>`,
  },
}

const DESKTOP_MENU_CSS = `<style>
  .desk { display: flex; gap: 1rem } .burger { display: none }
  @media (max-width: 600px) { .desk { display: none } .burger { display: block } }
</style>`
const MENU_JS = '<script>const b = document.querySelector(".burger"), m = document.getElementById("m"); b.addEventListener("click", () => { m.hidden = !m.hidden; b.setAttribute("aria-expanded", String(!m.hidden)) })</script>'

/** The device site's home: a desktop menu, and a phone menu behind a button that (on the defect site) leaves one page out. */
function deviceHome(broken) {
  const all = ['/about', '/defects/links.device.unreachable_on_phone', '/defects/links.device.covered']
  const phone = broken ? all.filter((p) => !p.includes('unreachable')) : all
  const link = (p) => `<a href="${p}">${p === '/about' ? 'About' : p.includes('unreachable') ? 'Desktop menu only' : 'Covered link'}</a>`
  return page({
    title: broken ? 'Device defects' : 'Device clean', seed: 'device-home', head: DESKTOP_MENU_CSS,
    header: `<header><nav class="desk" aria-label="Main">${all.map(link).join(' ')}</nav><button class="burger" aria-expanded="false" aria-controls="m">Menu</button><nav id="m" aria-label="Phone" hidden>${phone.map(link).join(' ')}</nav></header>`,
    after: MENU_JS,
  })
}

function measure(clean, path) {
  if (path === '/pixel.png') return { status: 200, type: 'image/png', body: PIXEL }
  if (path === '/') {
    const links = clean ? ['/clean/text', '/clean/picture', '/clean/form', '/clean/app'] : Object.keys(MEASURE_DEFECTS).map((r) => `/defects/${r}`)
    return { status: 200, body: page({ title: clean ? 'Measure clean' : 'Measure defects', seed: 'measure-home', extra: `<ul>${links.map((p) => `<li><a href="${p}">${esc(p)}</a></li>`).join('')}</ul>` }) }
  }
  if (clean) {
    switch (path) {
      case '/clean/text': return { status: 200, body: page({ title: 'Plain readable text', seed: 'clean-text' }) }
      case '/clean/picture': return { status: 200, body: page({ title: 'A described picture', seed: 'clean-picture', extra: '<p><img src="/pixel.png" width="40" height="40" alt="A small square"></p>' }) }
      case '/clean/form': return { status: 200, body: page({ title: 'A labelled form', seed: 'clean-form', extra: '<form action="/search"><label for="q">Search the site</label> <input id="q" type="text" name="q"><button type="submit">Search</button></form>' }) }
      // Script that adds to text the HTML already has: not JavaScript-only.
      case '/clean/app': return { status: 200, body: page({ title: 'Text the server sends', seed: 'clean-app', after: '<script>document.querySelector("main").insertAdjacentHTML("beforeend", "<p>Updated a moment ago.</p>")</script>' }) }
    }
    return { status: 404, body: page({ title: 'Not found', seed: 'nf' }) }
  }
  switch (path) {
    case '/defects/performance.lcp.slow/slow.css': return { status: 200, type: 'text/css', delayMs: SLOW_CSS_MS, body: 'main { color: #111 }' }
    case '/defects/performance.page_weight/heavy.js': return { status: 200, type: 'text/javascript', body: `/*${'x'.repeat(HEAVY_BYTES)}*/` }
    case '/defects/performance.ttfb.slow': return { status: 200, delayMs: SLOW_HTML_MS, body: page({ title: 'Defect: performance.ttfb.slow', seed: 'performance.ttfb.slow' }) }
  }
  const rule = path.startsWith('/defects/') ? path.slice('/defects/'.length) : null
  if (rule && MEASURE_DEFECTS[rule]) return { status: 200, body: page({ title: `Defect: ${rule}`, seed: rule, ...MEASURE_DEFECTS[rule] }) }
  return { status: 404, body: page({ title: 'Not found', seed: 'nf' }) }
}

function device(clean, path) {
  switch (path) {
    case '/': return { status: 200, body: deviceHome(!clean) }
    case '/about': return { status: 200, body: page({ title: 'About', seed: 'device-about', extra: '<p><a href="/">Home</a></p>' }) }
    case '/defects/links.device.unreachable_on_phone': return { status: 200, body: page({ title: 'Linked from the desktop menu', seed: 'device-desk', extra: '<p><a href="/">Home</a></p>' }) }
    case '/defects/links.device.covered':
      return {
        status: 200,
        body: page({
          title: 'A link under a banner', seed: 'device-covered',
          // On the defect site a cookie banner fixed to the bottom of the screen sits over the link.
          after: `<a href="/about" style="position:absolute;top:calc(100vh - 50px);left:20px">About us</a>${clean ? '' : '<div id="cookie" class="banner" style="position:fixed;left:0;right:0;bottom:0;height:120px;background:#fff;color:#111">We use cookies.</div>'}`,
        }),
      }
  }
  return { status: 404, body: page({ title: 'Not found', seed: 'nf' }) }
}

/**
 * @param {'measure' | 'device'} kind
 * @param {{ clean?: boolean }} [options]
 * @returns {Promise<{ origin: string, close: () => Promise<void> }>}
 */
export async function startBrowserSite(kind, { clean = false } = {}) {
  const server = http.createServer(async (req, res) => {
    const path = new URL(req.url, 'http://fixture').pathname
    const r = kind === 'measure' ? measure(clean, path) : device(clean, path)
    if (r.delayMs) await new Promise((resolve) => setTimeout(resolve, r.delayMs))
    if (res.destroyed) return
    res.writeHead(r.status, { 'content-type': r.type ?? 'text/html; charset=utf-8', 'cache-control': 'no-store' })
    res.end(req.method === 'HEAD' ? undefined : r.body)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    origin: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((resolve) => { server.closeAllConnections?.(); server.close(() => resolve()) }),
  }
}
