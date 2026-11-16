/**
 * Passive security suite (C05.4; rebuild/08 Suite 3, `passive` tier): reads
 * the responses the crawl already fetched, plus one request a browser would
 * also make (http:// of the start URL, to see whether it upgrades to HTTPS).
 * Header checks come from the concierge kit (apps/legacy/concierge).
 *
 * Headers are site-wide on almost every site, so header rules run on the
 * start page only: one finding per site, not one per page. Mixed content and
 * insecure forms are per page.
 *
 * HTTPS and HSTS rules are skipped for local targets (localhost, *.local,
 * *.localhost, IP literals), where `webtrax mcp` checks dev servers.
 *
 * Not yet: TLS certificate rules, cookies, vulnerable JavaScript, DNS/email,
 * security.txt (later C06 epics).
 */
import { isIP } from 'node:net'
import type { CheckSuite, CrawledPage, SuiteCtx } from '@webtrax/engine'
import type { RuleMeta } from '@webtrax/protocol'

const rule = (id: string, severity: RuleMeta['severity'], title: string, why: string, fix: string): RuleMeta => ({
  id, suite: 'security', title, version: 1, severity, why, fix, docs_slug: id.replace(/[._]/g, '-'), tags: [],
})

export const SECURITY_RULES = [
  rule('security.https.missing', 'high', 'Site is not served over HTTPS', 'Everything visitors send and receive can be read or changed in transit, and browsers mark the site "Not secure".', 'Get a certificate (most hosts provide one free) and serve the site over HTTPS.'),
  rule('security.https.not_enforced', 'high', 'HTTP does not redirect to HTTPS', 'Visitors who type the address or follow an old link stay on unencrypted HTTP.', 'Redirect every http:// request to https:// with a 301.'),
  rule('security.header.hsts_missing', 'medium', 'Strict-Transport-Security header missing', 'Without HSTS a visitor\'s first request can be downgraded to HTTP by an attacker on the network.', 'Send Strict-Transport-Security: max-age=31536000; includeSubDomains.'),
  rule('security.header.hsts_short', 'low', 'Strict-Transport-Security max-age is short', 'A short max-age lets the protection lapse between visits.', 'Use max-age of at least 15552000 (180 days); 31536000 is common.'),
  rule('security.header.csp_missing', 'medium', 'Content-Security-Policy missing', 'A CSP is the main defence that limits the damage of an injected script (XSS).', 'Add a Content-Security-Policy; start from a report-only policy built for your site, then enforce it.'),
  rule('security.header.csp_unsafe', 'low', 'Content-Security-Policy allows unsafe sources', '\'unsafe-inline\', \'unsafe-eval\' or a wildcard script source removes most of the protection a CSP gives.', 'Replace inline scripts with files, nonces or hashes, and list script origins explicitly.'),
  rule('security.header.nosniff_missing', 'low', 'X-Content-Type-Options header missing', 'Browsers may guess content types and run a file as script.', 'Send X-Content-Type-Options: nosniff.'),
  rule('security.header.referrer_policy_missing', 'low', 'Referrer-Policy header missing', 'Full URLs, which can carry private details, may be sent to other sites.', 'Send Referrer-Policy: strict-origin-when-cross-origin.'),
  rule('security.header.permissions_policy_missing', 'info', 'Permissions-Policy header missing', 'Embedded content can ask for features (camera, location) you never use.', 'Send Permissions-Policy: camera=(), microphone=(), geolocation=().'),
  rule('security.header.frame_protection_missing', 'medium', 'Page can be framed by other sites', 'Without frame protection, other sites can embed your pages and trick visitors into clicks (clickjacking).', 'Add frame-ancestors to your CSP, or send X-Frame-Options: SAMEORIGIN.'),
  rule('security.disclosure.version', 'low', 'Server software version disclosed', 'Version numbers in headers make it easy to match the site against known vulnerabilities.', 'Remove version numbers from the Server and X-Powered-By headers.'),
  rule('security.mixed_content', 'medium', 'HTTPS page loads resources over HTTP', 'Browsers block or warn about insecure resources, and they can be tampered with in transit.', 'Load every resource over https://.'),
  rule('security.form.insecure_action', 'high', 'Form on an HTTPS page submits over HTTP', 'Whatever the visitor types is sent unencrypted.', 'Change the form action to an https:// URL.'),
  rule('security.form.password_over_http', 'high', 'Password field on an HTTP page', 'Passwords typed here can be read in transit; browsers warn visitors.', 'Serve the page, and the form\'s target, over HTTPS.'),
] satisfies RuleMeta[]

/** Local targets where HTTPS is not expected (dev servers, `webtrax mcp`). */
export function isLocalHost(hostname: string): boolean {
  const h = hostname.replace(/^\[|\]$/g, '').toLowerCase()
  return h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.test') || isIP(h) !== 0
}

const HSTS_MIN_SECONDS = 15_552_000

/** Directives of a CSP, by name. */
export function parseCsp(value: string): Map<string, string[]> {
  const out = new Map<string, string[]>()
  for (const part of value.split(';')) {
    const [name, ...sources] = part.trim().split(/\s+/)
    if (name && !out.has(name.toLowerCase())) out.set(name.toLowerCase(), sources)
  }
  return out
}

/** Unsafe sources in script-src (or default-src when script-src is absent). Nonces and hashes make 'unsafe-inline' inert. */
export function unsafeCspSources(csp: string): string[] {
  const d = parseCsp(csp)
  const scripts = d.get('script-src') ?? d.get('default-src')
  if (!scripts) return []
  const neutralised = scripts.some((s) => /^'(nonce-|sha256-|sha384-|sha512-|strict-dynamic)/i.test(s))
  return scripts.filter((s) => (s === "'unsafe-inline'" && !neutralised) || s === "'unsafe-eval'" || s === '*' || s === 'http:' || s === 'https:' || s === 'data:')
}

async function checkHeaders(ctx: SuiteCtx, page: CrawledPage) {
  const h = page.outcome.headers ?? {}
  const url = page.url
  const https = url.startsWith('https://')
  const local = isLocalHost(new URL(url).hostname)

  if (!https && !local) await ctx.emit({ rule_id: 'security.https.missing', url })
  if (https && !local) {
    const hsts = h['strict-transport-security']
    if (!hsts) await ctx.emit({ rule_id: 'security.header.hsts_missing', url })
    else {
      const maxAge = Number(/max-age=(\d+)/i.exec(hsts)?.[1] ?? 0)
      if (maxAge < HSTS_MIN_SECONDS) await ctx.emit({ rule_id: 'security.header.hsts_short', url, evidence: { header: hsts.slice(0, 200), max_age: maxAge } })
    }
    // The one extra request: does http:// upgrade to https://?
    const plain = await ctx.request(url.replace(/^https:/, 'http:'))
    const upgrades = plain.status !== null && plain.status >= 300 && plain.status < 400 && plain.finalUrl.startsWith('https://')
    if (plain.status !== null && !upgrades) await ctx.emit({ rule_id: 'security.https.not_enforced', url: url.replace(/^https:/, 'http:'), evidence: { status: plain.status, ...(plain.finalUrl !== plain.url ? { location: plain.finalUrl } : {}) } })
  }

  const csp = h['content-security-policy']
  if (!csp) {
    const reportOnly = h['content-security-policy-report-only']
    await ctx.emit({ rule_id: 'security.header.csp_missing', url, ...(reportOnly ? { severity: 'low' as const, evidence: { mode: 'report-only' } } : {}) })
  } else {
    const unsafe = unsafeCspSources(csp)
    if (unsafe.length) await ctx.emit({ rule_id: 'security.header.csp_unsafe', url, evidence: { sources: unsafe } })
  }
  if (!/^nosniff$/i.test((h['x-content-type-options'] ?? '').trim())) await ctx.emit({ rule_id: 'security.header.nosniff_missing', url })
  if (!h['referrer-policy']) await ctx.emit({ rule_id: 'security.header.referrer_policy_missing', url })
  if (!h['permissions-policy']) await ctx.emit({ rule_id: 'security.header.permissions_policy_missing', url })
  const framed = !h['x-frame-options'] && !(csp && parseCsp(csp).has('frame-ancestors'))
  if (framed) await ctx.emit({ rule_id: 'security.header.frame_protection_missing', url })
  for (const name of ['server', 'x-powered-by']) {
    const value = h[name]
    if (value && /\d+\.\d+/.test(value)) await ctx.emit({ rule_id: 'security.disclosure.version', url, evidence_key: name, evidence: { header: name, value: value.slice(0, 200) } })
  }
}

export const securitySuite: CheckSuite = {
  id: 'security',
  version: '1.0.0',
  requires: ['http'],
  rules: SECURITY_RULES,

  async onPage(ctx, page) {
    if (page.url === ctx.startUrl) await checkHeaders(ctx, page)
    const { $, baseUrl } = page.doc
    const https = page.url.startsWith('https://')
    const abs = (v: string) => { try { return new URL(v, baseUrl).toString() } catch { return null } }

    if (https) {
      const insecure = new Set<string>()
      $('img[src], script[src], iframe[src], source[src], video[src], audio[src], embed[src], link[rel~="stylesheet"][href]').each((_, el) => {
        const value = $(el).attr('src') ?? $(el).attr('href') ?? ''
        const url = abs(value)
        if (url?.startsWith('http://')) insecure.add(url)
      })
      if (insecure.size) await ctx.emit({ rule_id: 'security.mixed_content', url: page.url, evidence: { count: insecure.size, examples: [...insecure].slice(0, 5) } })

      const actions = new Set<string>()
      $('form[action]').each((_, el) => {
        const url = abs($(el).attr('action') ?? '')
        if (url?.startsWith('http://')) actions.add(url)
      })
      for (const action of actions) await ctx.emit({ rule_id: 'security.form.insecure_action', url: page.url, evidence_key: action, evidence: { action } })
    } else if (!isLocalHost(new URL(page.url).hostname) && $('input[type="password" i]').length) {
      await ctx.emit({ rule_id: 'security.form.password_over_http', url: page.url })
    }
  },
}

export default securitySuite
