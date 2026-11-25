// The rules fixture (C06.8; plan/06-check-suites/ai-readiness-and-monitors.md §6):
// one page per rule the HTTP suites can find, named /defects/<rule_id>, and a
// clean twin of the site that must give no findings at all.
//
// One local server answers for several made-up hosts, told apart by the
// x-fixture-host and x-fixture-scheme headers that `virtualFetch` sends. The
// engine is given that fetch instead of the network, so every URL is a fixed
// https://shop.example/… address: findings, fingerprints and the score are the
// same on every run and every machine.
//
//   https://shop.example/        the defect site: its home page links to every /defects/ page;
//                                its home page's headers, robots.txt, sitemap.xml, llms.txt and
//                                apple-app-site-association carry the site-wide defects
//   http://shop.example/…        the same site over plain HTTP: answers instead of redirecting
//   http://plain.example/…       a site with no HTTPS at all (HTTPS, password and header rules)
//   https://short.example/…      a site whose start URL redirects and whose HSTS is short; www.short.example
//                                answers as the site too, www.clean.example redirects to clean.example
//   https://clean.example/       the clean twin: /clean/<suite> pages that do everything right
//   https://partner.example/…    another site: /ok, /copy, /missing (404), /slow, /pixel.png
//   https://members.example/     asks for a sign-in (401) whoever asks
//   https://botwall.example/     refuses WebtraxBot (403), answers browsers
//   https://busy.example/        always 429
//   https://docs.shop.example/   a GitHub Pages alias with nothing published there
//   https://down.example/        refuses connections
//   any other host               does not resolve
//
// The DNS and registry answers for the takeover rules are in `FIXTURE_LOOKUPS`.

import http from 'node:http'

/** The day the content suite judges dates by (its `today` setting), so copyright and "last updated" rules never drift. */
export const FIXTURE_TODAY = '2026-06-15'
export const FIXTURE_DICTIONARY = [{ term: 'Acme Classic', use: 'Acme One' }]

const WORDS = (
  'harbour lantern meadow copper orchard ribbon saddle timber violet walnut anchor basket candle drift ember falcon garnet hollow ivory juniper ' +
  'kettle ledger marble nectar oyster pebble quarry raven spindle thistle umber velvet willow yarrow zephyr amber birch cobalt dune fennel ' +
  'glacier heron indigo jasper kelp linen mosaic nutmeg opal pine quill russet sorrel tundra upland vessel wicker canyon bramble cedar ' +
  'delta estuary fjord grove heath isle jetty knoll lagoon mesa notch outcrop prairie ridge strand thicket vale weald crest gully bluff ' +
  'trail beacon cairn dormer eave gable hearth inglenook joist keystone lintel mullion newel oriel parapet quoin rafter sill transom'
).split(' ')

/** About `n` words of plain text, different for every seed and the same for the same seed. */
export function prose(seed, n = 90) {
  let h = 2166136261
  for (const ch of seed) h = Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0
  const next = () => (h = (Math.imul(h, 1103515245) + 12345) >>> 0)
  const out = []
  for (let i = 0; i < n; i++) out.push(WORDS[next() % WORDS.length])
  const sentences = []
  for (let i = 0; i < out.length; i += 9) {
    const s = out.slice(i, i + 9).join(' ')
    sentences.push(s[0].toUpperCase() + s.slice(1) + '.')
  }
  return sentences.join(' ')
}

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;')

/**
 * A page that every suite is happy with unless told otherwise: language, a
 * title and description of its own, social tags, one h1, enough text of its
 * own, structured data when `jsonLd` is set.
 */
function page(o) {
  const title = o.title === undefined ? o.h1 : o.title
  const description = o.description === undefined ? `What ${o.h1} shows, in a sentence of its own.` : o.description
  const image = o.og === 'broken' ? `/defects/seo.social.og_image_broken/card.png` : '/card.png'
  const og = o.og === false ? '' : `<meta property="og:title" content="${esc(title ?? o.h1)}"><meta property="og:description" content="${esc(description ?? o.h1)}"><meta property="og:image" content="${image}">`
  const head = [
    '<meta charset="utf-8">',
    title === null ? '' : `<title>${esc(title)}</title>`,
    description === null ? '' : `<meta name="description" content="${esc(description)}">`,
    og,
    o.jsonLd ? `<script type="application/ld+json">${o.jsonLd}</script>` : '',
    o.head ?? '',
  ].join('')
  const body = o.main ?? `<p>${prose(o.seed ?? o.h1)}</p>`
  return `<!doctype html><html${o.lang === null ? '' : ` lang="${o.lang ?? 'en'}"`}><head>${head}</head><body>` +
    `${o.h1 === null ? '' : `<h1>${esc(o.h1)}</h1>`}${o.nav ? `<nav>${o.nav}</nav>` : ''}<main>${body}${o.extra ?? ''}</main>${o.footer ? `<footer>${o.footer}</footer>` : ''}</body></html>`
}

const SHOP = 'https://shop.example'
const ld = (name) => JSON.stringify({ '@context': 'https://schema.org', '@type': 'WebPage', name })

/**
 * The defect pages, by rule. Each is otherwise clean, so the only finding on
 * it is its own rule's (the test checks that). Rules found somewhere other
 * than their page (site-wide ones, the start page's headers, other hosts) are
 * listed in `ELSEWHERE`.
 */
export const DEFECTS = {
  // links
  'links.broken.internal': { extra: '<p><a href="/defects/links.broken.internal/missing">An old page</a></p>' },
  'links.broken.external': { extra: '<p><a href="https://partner.example/missing">A partner page that is gone</a></p>' },
  'links.timeout': { extra: '<p><a href="https://partner.example/slow">A partner page that never answers</a></p>' },
  'links.dns_failure': { extra: '<p><a href="https://nowhere.example/">A site whose name does not resolve</a></p>' },
  'links.unreachable': { extra: '<p><a href="https://down.example/">A site that refuses connections</a></p>' },
  'links.redirect.chain': { extra: '<p><a href="/defects/links.redirect.chain/1">A page moved three times</a></p>' },
  'links.redirect.to_http': { extra: '<p><a href="http://shop.example/defects/links.redirect.to_http/target">The same site over plain HTTP</a></p>' },
  'links.scheme.invalid': { extra: '<p><a href="mailto:not-an-address">Email us</a></p>' },
  'links.soft_404': { h1: 'Page not found', title: 'Page not found | Shop example', main: `<p>${prose('links.soft_404')}</p>` },
  'links.canonical.broken': { head: '<link rel="canonical" href="/defects/links.canonical.broken/gone">' },
  'links.unverified': { extra: '<p><a href="https://members.example/">The members area</a></p>' },
  'links.device.response_differs': { extra: '<p><a href="https://botwall.example/">A site that turns checkers away</a></p>' },
  'links.host_rate_limited': { extra: '<p><a href="https://busy.example/">A site that is always busy</a></p>' },
  'links.orphan': {},
  // security
  'security.mixed_content': { extra: '<p><img src="http://partner.example/pixel.png" alt="A partner badge"></p>' },
  'security.form.insecure_action': { extra: '<form action="http://partner.example/subscribe"><label>Email <input name="email" type="email"></label><button>Subscribe</button></form>' },
  'security.takeover.domain_available': { head: '<script src="https://cdn.gone-brand.example/widget.js"></script>' },
  'security.takeover.dangling_cname': { extra: '<iframe src="https://docs.shop.example/" title="Documentation"></iframe>' },
  // seo
  'seo.title.missing': { title: null },
  'seo.title.too_long': { title: 'A title that goes on and on well past what any search result will ever show in full' },
  'seo.title.duplicate': { title: 'Two pages, one title', extra: '<p><a href="/defects/seo.title.duplicate/twin">Its twin</a></p>' },
  'seo.meta_description.missing': { description: null },
  'seo.meta_description.duplicate': { description: 'Two pages that share this one description.', extra: '<p><a href="/defects/seo.meta_description.duplicate/twin">Its twin</a></p>' },
  'seo.h1.missing': { h1: null, title: 'A page without a main heading' },
  'seo.h1.multiple': { extra: '<h1>A second main heading</h1>' },
  'seo.noindex': { head: '<meta name="robots" content="noindex">' },
  'seo.lang.missing': { lang: null },
  'seo.canonical.multiple': { head: `<link rel="canonical" href="${SHOP}/defects/seo.canonical.multiple"><link rel="canonical" href="${SHOP}/">` },
  'seo.canonical.cross_domain': { head: '<link rel="canonical" href="https://partner.example/copy">' },
  'seo.social.og_missing': { og: false },
  'seo.headings.skipped_level': { extra: '<h3>A heading two levels down</h3>' },
  'seo.links.nofollow_internal': { extra: '<p><a href="/" rel="nofollow">Home</a></p>' },
  'seo.hreflang.invalid': { head: `<link rel="alternate" hreflang="english" href="${SHOP}/defects/seo.hreflang.invalid">` },
  'seo.robots.blocks_sitemap_url': {},
  'seo.meta_description.too_long': { description: 'A description that keeps going well past the point where any search result would stop showing it, because it tries to say everything about the page in one breath instead of one sentence.' },
  'seo.canonical.to_noindex': { head: `<link rel="canonical" href="${SHOP}/defects/seo.canonical.to_noindex/hidden">` },
  'seo.canonical.sitemap_mismatch': { head: `<link rel="canonical" href="${SHOP}/defects/seo.canonical.sitemap_mismatch/real">` },
  'seo.links.deep': { extra: '<p><a href="/defects/seo.links.deep/1">One level down</a></p>' },
  'seo.social.og_image_broken': { head: '<meta property="og:image:alt" content="A card">', og: 'broken' },
  // content
  'content.placeholder': { extra: '<p>Lorem ipsum dolor sit amet, consectetur adipiscing elit.</p>' },
  'content.dictionary': { extra: '<p>Upgrade from Acme Classic today.</p>' },
  'content.date_stale': { extra: '<p>Last updated: March 2019</p>' },
  'content.copyright_stale': { footer: '<p>© 2019 Shop Example</p>' },
  'content.empty_page': { main: '<p>Coming soon.</p>' },
  'content.duplicate': { main: `<p>${prose('content.duplicate.shared', 100)}</p>`, extra: '<p><a href="/defects/content.duplicate/copy">The copy</a></p>' },
  // ai_readiness
  'ai_readiness.schema.invalid': { jsonLd: '{"@type": "Organization",}' },
}

/** Pages under a defect page that the defect needs (twins, redirect hops, targets). */
const SUB_PAGES = {
  '/defects/seo.title.duplicate/twin': { h1: 'The duplicate title\'s twin', title: 'Two pages, one title' },
  '/defects/seo.meta_description.duplicate/twin': { h1: 'The duplicate description\'s twin', description: 'Two pages that share this one description.' },
  '/defects/content.duplicate/copy': { h1: 'The copy of a page', main: `<p>${prose('content.duplicate.shared', 100)}</p>` },
  '/defects/links.redirect.chain/end': { h1: 'Where the moved page ended up' },
  '/defects/links.redirect.to_http/target': { h1: 'The page the plain HTTP link meant' },
  '/defects/seo.canonical.to_noindex/hidden': { h1: 'A page kept out of search', head: '<meta name="robots" content="noindex">' },
  '/defects/seo.canonical.sitemap_mismatch/real': { h1: 'The page the sitemap should list' },
  '/defects/seo.links.deep/1': { h1: 'Two clicks down', extra: '<p><a href="/defects/seo.links.deep/2">Further</a></p>' },
  '/defects/seo.links.deep/2': { h1: 'Three clicks down', extra: '<p><a href="/defects/seo.links.deep/3">Further</a></p>' },
  '/defects/seo.links.deep/3': { h1: 'Four clicks down', extra: '<p><a href="/defects/seo.links.deep/4">Further</a></p>' },
  '/defects/seo.links.deep/4': { h1: 'Five clicks down' },
}

/** Sitemap-only and robots-only pages: in the sitemap, and (but for the orphan) linked from the home page. */
const SITEMAP = ['/', '/defects/links.orphan', '/defects/links.sitemap.stale', '/defects/seo.robots.blocks_sitemap_url', '/defects/seo.canonical.sitemap_mismatch']

/**
 * Where the rules not found on their own page are expected, as URL paths on
 * shop.example or full URLs elsewhere. `null`: a site-wide finding (no URL).
 */
export const ELSEWHERE = {
  'links.sitemap.stale': ['/defects/links.sitemap.stale'],
  'links.device.response_differs': ['https://botwall.example/'],
  'links.unverified': ['https://members.example/'],
  'links.host_rate_limited': ['https://busy.example/'],
  'links.app.association_invalid': ['/.well-known/apple-app-site-association'],
  'links.redirect.start': ['https://short.example/old-home'],
  'security.https.not_enforced': ['http://shop.example/', 'http://short.example/'],
  'security.https.missing': ['http://plain.example/defects/security.https.missing'],
  'security.form.password_over_http': ['http://plain.example/defects/security.https.missing'],
  'security.header.hsts_missing': ['/'],
  'security.header.hsts_short': ['https://short.example/'],
  'security.header.csp_unsafe': ['/'],
  'security.header.csp_missing': ['http://plain.example/defects/security.https.missing', 'https://short.example/'],
  'security.header.nosniff_missing': ['/', 'http://plain.example/defects/security.https.missing', 'https://short.example/'],
  'security.header.referrer_policy_missing': ['/', 'http://plain.example/defects/security.https.missing', 'https://short.example/'],
  'security.header.permissions_policy_missing': ['/', 'http://plain.example/defects/security.https.missing', 'https://short.example/'],
  'security.header.frame_protection_missing': ['/', 'http://plain.example/defects/security.https.missing', 'https://short.example/'],
  'security.disclosure.version': ['/'],
  'security.takeover.dangling_cname': ['https://docs.shop.example/'],
  'ai_readiness.llms_txt.invalid': ['/llms.txt'],
  'ai_readiness.llms_txt.missing': [null],
  'ai_readiness.schema.none': [null],
  'ai_readiness.crawlers.policy': ['/robots.txt', 'http://plain.example/robots.txt'],
  'ai_readiness.crawlers.inconsistent': ['/robots.txt'],
  'content.copyright_stale': [null],
  // The canonical.to_noindex defect needs a page that asks not to be indexed.
  'seo.noindex': ['/defects/seo.canonical.to_noindex/hidden'],
  'seo.host.not_canonicalised': ['https://www.short.example/'],
}

/** Every finding the clean twin may give: the AI crawler summary is always reported, as information. */
export const CLEAN_ALLOWED = ['ai_readiness.crawlers.policy']

/** DNS and registry answers for the takeover rules (`CrawlDeps.lookups`). Everything else resolves and is registered. */
export const FIXTURE_LOOKUPS = {
  dns: async (host) => {
    if (host === 'docs.shop.example') return { status: 'ok', cname: ['shop-docs.github.io'], addresses: ['203.0.113.10'] }
    if (host === 'cdn.gone-brand.example' || host === 'nowhere.example') return { status: 'nxdomain', cname: [], addresses: [] }
    return { status: 'ok', cname: [], addresses: ['203.0.113.7'] }
  },
  registration: async (domain) => (domain === 'gone-brand.example' ? 'available' : 'registered'),
}

/** WebtraxBot's own user agent, not the phone or desktop browser ones that carry its token (they name Chrome). */
const isBot = (ua) => /WebtraxBot/.test(ua) && !/Chrome\//.test(ua)

const STRONG_HEADERS = {
  'strict-transport-security': 'max-age=31536000; includeSubDomains',
  'content-security-policy': "default-src 'self'; frame-ancestors 'none'",
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'strict-origin-when-cross-origin',
  'permissions-policy': 'camera=(), microphone=(), geolocation=()',
}
// The defect site's start page: no HSTS, an unsafe CSP without frame-ancestors, no other headers, a version in Server.
const WEAK_HEADERS = { 'content-security-policy': "default-src 'self'; script-src 'self' 'unsafe-inline'", server: 'fixture/1.2' }

function shop(path, scheme, ua) {
  if (scheme === 'http') {
    // Plain HTTP answers instead of upgrading, at the start page (security.https.not_enforced);
    // the link to /defects/links.redirect.to_http/target is sent on to HTTPS.
    if (path === '/') return { status: 200, body: page({ h1: 'Shop example over HTTP', seed: 'shop-http' }) }
    return { status: 301, headers: { location: `${SHOP}${path}` } }
  }
  const headers = path === '/' ? WEAK_HEADERS : STRONG_HEADERS
  switch (path) {
    case '/robots.txt':
      return { status: 200, type: 'text/plain', body: 'User-agent: Googlebot\nDisallow: /defects/seo.robots.blocks_sitemap_url\n\nUser-agent: ChatGPT-User\nDisallow: /\n\nUser-agent: *\nDisallow:\n\nSitemap: https://shop.example/sitemap.xml\n' }
    case '/sitemap.xml':
      return { status: 200, type: 'application/xml', body: `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${SITEMAP.map((p) => `<url><loc>${SHOP}${p}</loc></url>`).join('')}</urlset>` }
    case '/llms.txt':
      return { status: 200, type: 'text/plain', body: 'Shop example\n\nEverything about the shop, without a title or a single link.\n' }
    case '/.well-known/apple-app-site-association':
      return { status: 200, type: 'text/plain', body: '{"hello": true}' }
    case '/':
      return {
        status: 200, headers,
        body: page({
          h1: 'Shop example', title: 'Shop example: every defect', seed: 'shop-home',
          nav: `<ul>${Object.keys(DEFECTS).filter((r) => r !== 'links.orphan').map((r) => `<li><a href="/defects/${r}">${r}</a></li>`).join('')}</ul>`,
        }),
      }
    case '/defects/links.redirect.chain/1': return { status: 301, headers: { location: '/defects/links.redirect.chain/2' } }
    case '/defects/links.redirect.chain/2': return { status: 301, headers: { location: '/defects/links.redirect.chain/3' } }
    case '/defects/links.redirect.chain/3': return { status: 301, headers: { location: '/defects/links.redirect.chain/end' } }
    case '/defects/links.device.response_differs':
      // Fine for WebtraxBot, a server error for phone and desktop browsers.
      if (!isBot(ua)) return { status: 500, type: 'text/plain', body: 'Internal Server Error' }
  }
  if (SUB_PAGES[path]) return { status: 200, headers, body: page({ seed: path, ...SUB_PAGES[path] }) }
  const rule = path.startsWith('/defects/') ? path.slice('/defects/'.length) : null
  if (rule && DEFECTS[rule]) return { status: 200, headers, body: page({ h1: `Defect: ${rule}`, title: `Defect page for ${rule}`, description: `The page in the test site that shows ${rule}.`, seed: rule, ...DEFECTS[rule] }) }
  return { status: 404, body: page({ h1: 'Not found', seed: 'not-found' }) }
}

const CLEAN = 'https://clean.example'
const CLEAN_PAGES = {
  '/clean/links': {
    h1: 'Links that all work',
    extra: '<p><a href="/clean/links/moved">A page that moved once</a> · <a href="https://partner.example/ok">A partner</a> · <a href="mailto:hello@clean.example">Email us</a> · <a href="tel:+441234567890">Call us</a></p>',
  },
  '/clean/links/here': { h1: 'Where the moved page lives now' },
  '/clean/security': {
    h1: 'A secure page',
    extra: '<p><img src="https://partner.example/pixel.png" alt="A partner badge"></p><form action="https://clean.example/subscribe"><label>Email <input name="email" type="email"></label><button>Subscribe</button></form>',
  },
  '/clean/seo': {
    h1: 'Search engines understand this page',
    head: `<link rel="canonical" href="${CLEAN}/clean/seo"><link rel="alternate" hreflang="en" href="${CLEAN}/clean/seo"><link rel="alternate" hreflang="x-default" href="${CLEAN}/clean/seo">`,
    extra: '<h2>A section</h2><h3>A subsection</h3>',
  },
  '/clean/content': { h1: 'Finished, current content', extra: '<p>Last updated: May 2026</p>' },
  '/clean/ai_readiness': { h1: 'Ready for AI assistants' },
}

function clean(path, scheme) {
  if (scheme === 'http') return { status: 301, headers: { location: `${CLEAN}${path}` } }
  const footer = '<p>© 2026 Clean Example</p>'
  switch (path) {
    case '/robots.txt': return { status: 200, type: 'text/plain', body: 'User-agent: *\nAllow: /\n\nSitemap: https://clean.example/sitemap.xml\n' }
    case '/sitemap.xml':
      return { status: 200, type: 'application/xml', body: `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${['/', ...Object.keys(CLEAN_PAGES).filter((p) => !p.includes('/here'))].map((p) => `<url><loc>${CLEAN}${p}</loc></url>`).join('')}</urlset>` }
    case '/llms.txt':
      return { status: 200, type: 'text/markdown', body: `# Clean example\n\n> A site that does everything right.\n\n${Object.keys(CLEAN_PAGES).filter((p) => !p.includes('/here')).map((p) => `- [${p}](${CLEAN}${p})`).join('\n')}\n` }
    case '/clean/links/moved': return { status: 301, headers: { location: '/clean/links/here' } }
    case '/':
      return {
        status: 200, headers: STRONG_HEADERS,
        body: page({ h1: 'Clean example', seed: 'clean-home', jsonLd: ld('Clean example'), footer, nav: `<ul>${Object.keys(CLEAN_PAGES).filter((p) => !p.includes('/here')).map((p) => `<li><a href="${p}">${p.slice(7)}</a></li>`).join('')}</ul>` }),
      }
  }
  if (CLEAN_PAGES[path]) return { status: 200, headers: STRONG_HEADERS, body: page({ seed: path, jsonLd: ld(CLEAN_PAGES[path].h1), footer, ...CLEAN_PAGES[path] }) }
  return { status: 404, headers: STRONG_HEADERS, body: page({ h1: 'Not found', seed: 'clean-404' }) }
}

function route(host, scheme, path, ua) {
  // Every page's social preview image.
  if (path === '/card.png' && host !== 'partner.example') return { status: 200, type: 'image/png', body: 'png' }
  switch (host) {
    case 'shop.example': return shop(path, scheme, ua)
    case 'clean.example': return clean(path, scheme)
    case 'plain.example':
      // No HTTPS, a password field, no headers, no robots.txt, llms.txt or structured data.
      if (path === '/defects/security.https.missing') return { status: 200, body: page({ h1: 'Sign in', seed: 'plain', extra: '<form action="/login"><label>Password <input type="password" name="pw"></label><button>Sign in</button></form>' }) }
      return { status: 404, body: page({ h1: 'Not found', seed: 'plain-404' }) }
    case 'short.example':
      if (scheme === 'http') return { status: 200, body: page({ h1: 'Short over HTTP', seed: 'short-http' }) }
      if (path === '/old-home') return { status: 301, headers: { location: '/' } }
      if (path === '/') return { status: 200, headers: { 'strict-transport-security': 'max-age=60' }, body: page({ h1: 'Short example', seed: 'short' }) }
      return { status: 404, body: page({ h1: 'Not found', seed: 'short-404' }) }
    case 'partner.example':
      if (path === '/ok' || path === '/copy') return { status: 200, body: page({ h1: `Partner ${path}`, seed: path }) }
      if (path === '/pixel.png') return { status: 200, type: 'image/png', body: 'png' }
      if (path === '/slow') return { status: 200, delayMs: 2_000, body: page({ h1: 'Slow', seed: 'slow' }) }
      return { status: 404, body: page({ h1: 'Not found', seed: 'partner-404' }) }
    // The short site's other host answers as the site too (seo.host.not_canonicalised); the clean twin's redirects.
    case 'www.short.example': return { status: 200, body: page({ h1: 'Short example on www', seed: 'short-www' }) }
    case 'www.clean.example': return { status: 301, headers: { location: `${CLEAN}${path}` } }
    case 'members.example': return { status: 401, headers: { 'www-authenticate': 'Basic realm="members"' }, body: 'Sign in' }
    case 'botwall.example': return isBot(ua) ? { status: 403, body: 'Bots not allowed' } : { status: 200, body: page({ h1: 'Botwall', seed: 'botwall' }) }
    case 'busy.example': return { status: 429, headers: { 'retry-after': '0' }, body: 'Too many requests' }
    case 'docs.shop.example': return { status: 404, body: '<!doctype html><html><head><title>Site not found · GitHub Pages</title></head><body><h1>404</h1><p>There isn\'t a GitHub Pages site here.</p></body></html>' }
    default: return { status: 404, body: 'unknown host' }
  }
}

/** The hosts the fixture answers for; `down.example` refuses connections, and any other host does not resolve. */
export const FIXTURE_HOSTS = ['shop.example', 'clean.example', 'www.clean.example', 'plain.example', 'short.example', 'www.short.example', 'partner.example', 'members.example', 'botwall.example', 'busy.example', 'docs.shop.example']

/** @returns {Promise<{ port: number, requests: Array<{ method: string, url: string, ua: string }>, close: () => Promise<void> }>} */
export async function startRulesSite() {
  const requests = []
  const server = http.createServer(async (req, res) => {
    const host = String(req.headers['x-fixture-host'] ?? '')
    const scheme = req.headers['x-fixture-scheme'] === 'http' ? 'http' : 'https'
    const url = new URL(req.url, `${scheme}://${host}`)
    const ua = String(req.headers['user-agent'] ?? '')
    requests.push({ method: req.method, url: url.href, ua })
    const r = route(host, scheme, url.pathname, ua)
    if (r.delayMs) await new Promise((resolve) => setTimeout(resolve, r.delayMs))
    if (res.destroyed) return
    res.writeHead(r.status, { 'content-type': r.type ?? 'text/html; charset=utf-8', ...(r.headers ?? {}) })
    res.end(req.method === 'HEAD' ? undefined : (r.body ?? ''))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    port: server.address().port,
    requests,
    close: () => new Promise((resolve) => { server.closeAllConnections?.(); server.close(() => resolve()) }),
  }
}

const netError = (message, code) => Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error(message), { code }) })

/**
 * A fetch with the engine's GuardedFetch shape (call, `policy`, `close`) that
 * sends every request for a fixture host to the local server, follows
 * redirects itself unless asked not to, and fails other hosts the way the
 * network would. `policy` is the caller's (a ScopePolicy).
 */
export function virtualFetch(port, policy) {
  const once = async (target, init) => {
    const u = new URL(target)
    if (u.hostname === 'down.example') throw netError(`connect ECONNREFUSED ${u.hostname}:443`, 'ECONNREFUSED')
    if (!FIXTURE_HOSTS.includes(u.hostname)) throw netError(`getaddrinfo ENOTFOUND ${u.hostname}`, 'ENOTFOUND')
    const headers = new Headers(init.headers ?? {})
    headers.set('x-fixture-host', u.hostname)
    headers.set('x-fixture-scheme', u.protocol.slice(0, -1))
    return fetch(`http://127.0.0.1:${port}${u.pathname}${u.search}`, { method: init.method ?? 'GET', headers, signal: init.signal, redirect: 'manual' })
  }
  const go = async (url, { originHeaders: _o, ...init } = {}) => {
    let current = new URL(url).toString()
    const chain = []
    for (;;) {
      const response = await once(current, init)
      const location = response.headers.get('location')
      if (init.redirect === 'manual' || response.status < 300 || response.status >= 400 || !location) return { response, url: current, chain }
      chain.push({ url: current, status: response.status })
      await response.body?.cancel().catch(() => {})
      if (chain.length > 10) throw Object.assign(new Error('too many redirects'), { code: 'ETOOMANYREDIRECTS' })
      current = new URL(location, current).toString()
    }
  }
  return Object.assign(go, { policy, close: async () => {} })
}
