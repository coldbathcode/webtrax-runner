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
import { registrableDomain, type CheckSuite, type CrawledPage, type SiteState, type SuiteCtx } from '@webtrax/engine'
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
  rule('security.takeover.domain_available', 'high', 'A domain the site uses can be registered by anyone', 'The site loads from or links to a domain that no longer exists and that its registry says is not registered. Whoever registers it next controls what is served there: a script or stylesheet from it would run on your pages, a frame would show their content inside yours, and a link would send visitors to them.', 'Remove or replace everything that points at the domain. If it was yours, register it again before someone else does.'),
  rule('security.takeover.dangling_cname', 'high', 'A subdomain points at a service nothing is claimed on', 'A name on your domain is an alias (CNAME) for a hosting service, and that service has nothing set up there any more: the alias target does not exist, or the service answers that no site is configured. Anyone with an account on that service can usually claim the name and serve their own pages on your domain.', 'Delete the DNS record if the subdomain is no longer used, or set the site up again on the service so the name is yours.'),
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

type Kind = 'script' | 'stylesheet' | 'frame' | 'link'
const KIND_RANK: Kind[] = ['script', 'stylesheet', 'frame', 'link']
const KIND_SEVERITY: Record<Kind, RuleMeta['severity']> = { script: 'critical', stylesheet: 'critical', frame: 'high', link: 'medium' }
/** Hosts the site's pages load scripts, stylesheets and frames from, per run (onPage to onSite). */
const resources = new WeakMap<SuiteCtx, Map<string, { kind: Kind; url: string; pages: Set<string> }>>()

/**
 * Hosting services whose names can be claimed again once a site on them is
 * gone (from the public can-i-take-over-xyz list, kept to those marked
 * vulnerable). `nx`: the alias target no longer existing is the sign.
 * `says`: what the service answers on the name when nothing is set up there.
 */
export const TAKEOVER_SERVICES: { name: string; host: RegExp; nx?: true; says?: RegExp }[] = [
  { name: 'GitHub Pages', host: /\.github\.io$/, says: /There isn't a GitHub Pages site here/ },
  { name: 'Amazon S3', host: /(^|\.)s3[.-]([a-z0-9-]+\.)?amazonaws\.com$/, says: /<Code>NoSuchBucket<\/Code>|The specified bucket does not exist/ },
  { name: 'Microsoft Azure', host: /\.(azurewebsites\.net|cloudapp\.net|cloudapp\.azure\.com|trafficmanager\.net|blob\.core\.windows\.net|azureedge\.net|azure-api\.net|azurefd\.net|azurecontainer\.io|azurehdinsight\.net|redis\.cache\.windows\.net|search\.windows\.net|servicebus\.windows\.net)$/, nx: true },
  { name: 'Heroku', host: /\.(herokuapp|herokudns|herokussl)\.com$/, nx: true, says: /no-such-app\.html|There's nothing here, yet\./ },
  { name: 'Bitbucket', host: /\.bitbucket\.io$/, says: /Repository not found/ },
  { name: 'Ghost', host: /\.ghost\.io$/, says: /Site unavailable\.|Failed to resolve DNS path for this host/ },
  { name: 'Pantheon', host: /\.pantheonsite\.io$/, says: /The gods are wise, but do not know of the site which you seek/ },
  { name: 'Surge', host: /\.surge\.sh$/, says: /project not found/ },
  { name: 'Shopify', host: /\.myshopify\.com$/, says: /Sorry, this shop is currently unavailable/ },
  { name: 'Tumblr', host: /^domains\.tumblr\.com$/, says: /Whatever you were looking for doesn't currently exist at this address/ },
  { name: 'WordPress.com', host: /\.wordpress\.com$/, says: /Do you want to register .*\.wordpress\.com\?/ },
  { name: 'ReadMe', host: /\.readme\.io$/, says: /Project doesnt exist\.\.\. yet!/ },
  { name: 'Zendesk', host: /\.zendesk\.com$/, says: /Help Center Closed/ },
]
export const serviceFor = (target: string) => TAKEOVER_SERVICES.find((s) => s.host.test(target.toLowerCase().replace(/\.$/, '')))

const hostOf = (url: string) => { try { return new URL(url).hostname.toLowerCase() } catch { return null } }
const pathOf = (site: SiteState, url: string) => (url.startsWith(`${site.origin}/`) ? url.slice(site.origin.length) : url)

/**
 * Takeover watch (C06.9 slice e, F-A24). Passive: DNS, the registry's RDAP
 * answer, and one ordinary GET of the site's own names that are aliases for a
 * hosting service. Never claims or registers anything. Skipped for local
 * targets.
 */
async function takeoverWatch(ctx: SuiteCtx, site: SiteState): Promise<void> {
  const own = hostOf(site.origin)
  if (!own || isLocalHost(own)) return
  const ownDomain = registrableDomain(own)
  // Other sites the pages use: resources from onPage, link targets from the crawl.
  const used = new Map<string, { kind: Kind; url: string; pages: Set<string> }>(resources.get(ctx) ?? [])
  for (const e of site.edges) {
    if (e.kind !== 'link') continue
    const host = hostOf(e.to)
    if (!host || host === own) continue
    const u = used.get(host) ?? { kind: 'link' as Kind, url: e.to, pages: new Set<string>() }
    u.pages.add(e.from)
    used.set(host, u)
  }
  // 1. Domains that no longer exist and can be registered: one finding per domain, at its worst use.
  const byDomain = new Map<string, { kind: Kind; url: string; hosts: Set<string>; pages: Set<string> }>()
  // At most 300 hosts a run are looked up: the rest are said nothing about.
  for (const [host, u] of [...used].slice(0, 300)) {
    const domain = registrableDomain(host)
    if (!domain || domain === ownDomain || isLocalHost(host)) continue
    // A link the crawl reached is there; only names that failed, and resources it never fetched, are looked up.
    const outcome = site.links.get(u.url)
    if (u.kind === 'link' && outcome && outcome.error !== 'dns_error') continue
    if ((await ctx.dns(host)).status !== 'nxdomain') continue
    const d = byDomain.get(domain) ?? { kind: u.kind, url: u.url, hosts: new Set<string>(), pages: new Set<string>() }
    if (KIND_RANK.indexOf(u.kind) < KIND_RANK.indexOf(d.kind)) { d.kind = u.kind; d.url = u.url }
    d.hosts.add(host)
    for (const p of u.pages) d.pages.add(p)
    byDomain.set(domain, d)
  }
  for (const [domain, d] of byDomain) {
    if ((await ctx.registration(domain)) !== 'available') continue
    const pages = [...d.pages].sort()
    await ctx.emit({
      rule_id: 'security.takeover.domain_available', url: d.url, ...(pages[0] ? { source_url: pages[0] } : {}), evidence_key: domain, severity: KIND_SEVERITY[d.kind],
      title: `${d.kind === 'link' ? 'Links go' : d.kind === 'frame' ? 'A frame loads from' : `A ${d.kind} loads from`}${d.kind === 'link' ? ' to' : ''} ${domain}, which anyone can register`,
      evidence: { domain, used_as: d.kind, hosts: [...d.hosts].slice(0, 5), pages: pages.slice(0, 5).map((p) => pathOf(site, p)), on_pages: pages.length, dns: 'does not exist', registry: 'not registered' },
    })
  }
  // 2. The site's own names that are aliases for a service with nothing claimed on them.
  const names = new Set([own])
  for (const host of used.keys()) if (ownDomain && registrableDomain(host) === ownDomain) names.add(host)
  if (ownDomain && ownDomain !== own) names.add(ownDomain)
  for (const name of [...names].slice(0, 50)) {
    const answer = await ctx.dns(name)
    const target = answer.cname[answer.cname.length - 1]
    const service = target ? serviceFor(target) : undefined
    if (!target || !service) continue
    let proof: string | null = null
    if (service.nx && answer.status === 'nxdomain') proof = `${target} does not exist`
    else if (service.says && answer.status === 'ok') {
      const o = await ctx.text(`https://${name}/`, 64 * 1024)
      const body = o.body ?? (o.error ? (await ctx.text(`http://${name}/`, 64 * 1024)).body : undefined)
      const said = body?.match(service.says)?.[0]
      if (said) proof = `${service.name} answers "${said.slice(0, 120)}"`
    }
    if (!proof) continue
    await ctx.emit({
      rule_id: 'security.takeover.dangling_cname', url: `https://${name}/`, evidence_key: name,
      title: `${name} points at ${service.name}, where nothing is set up`,
      evidence: { name, cname: answer.cname.slice(0, 8), service: service.name, proof },
    })
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

    // What the page loads from other hosts, for the takeover watch at the end of the run.
    const used = resources.get(ctx) ?? new Map<string, { kind: Kind; url: string; pages: Set<string> }>()
    resources.set(ctx, used)
    const own = hostOf(page.url)
    $('script[src], link[rel~="stylesheet" i][href], iframe[src]').each((_, el) => {
      const tag = (el as { tagName?: string }).tagName?.toLowerCase()
      const kind: Kind = tag === 'script' ? 'script' : tag === 'iframe' ? 'frame' : 'stylesheet'
      const url = abs($(el).attr('src') ?? $(el).attr('href') ?? '')
      const host = url && /^https?:/i.test(url) ? hostOf(url) : null
      if (!host || host === own || used.size >= 500 && !used.has(host)) return
      const u = used.get(host) ?? { kind, url: url!, pages: new Set<string>() }
      if (KIND_RANK.indexOf(kind) < KIND_RANK.indexOf(u.kind)) { u.kind = kind; u.url = url! }
      u.pages.add(page.url)
      used.set(host, u)
    })

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

  async onSite(ctx, site) {
    await takeoverWatch(ctx, site)
  },
}

export default securitySuite
