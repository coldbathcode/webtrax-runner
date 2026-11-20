/**
 * Links suite (C05.4): v1's broken-link semantics plus the rebuild/08 link
 * rules that need no browser. It reads what the crawl already fetched; it
 * makes no requests of its own.
 *
 * One finding per broken target and source page (same fingerprint for the
 * target, so the cloud groups them as occurrences of one finding). A
 * redirect the crawl stopped at a page it already had is resolved through
 * that page's own result, so its effective status and total hops are known.
 *
 * Not yet: `links.anchor.missing` and `links.asset.broken` (need the browser
 * stage or asset checks, C05.10).
 */
import { linkProblem, type CheckSuite, type LinkOutcome, type SiteState, type SuiteCtx } from '@webtrax/engine'
import { normaliseUrl, type RuleMeta } from '@webtrax/protocol'

const rule = (id: string, severity: RuleMeta['severity'], title: string, why: string, fix: string): RuleMeta => ({
  id, suite: 'links', title, version: 1, severity, why, fix, docs_slug: id.replace(/\./g, '-').replace(/_/g, '-'), tags: [],
})

export const LINK_RULES = [
  rule('links.broken.internal', 'high', 'Broken internal link', 'Visitors and search engines following this link reach an error page on your own site.', 'Point the link at the page that exists now, or add a redirect from the old URL to it.'),
  rule('links.broken.external', 'medium', 'Broken external link', 'The page you link to is gone or failing, which reads as neglect and wastes the click.', 'Update the link to the page\'s new address, link to an archived copy, or remove it.'),
  rule('links.timeout', 'medium', 'Link timed out', 'The linked page did not answer in time, even after a retry.', 'Check whether the target is down or very slow; replace the link if it stays that way.'),
  rule('links.dns_failure', 'high', 'Link to a domain that no longer resolves', 'The domain has no DNS record: it may have expired, and an expired domain can be registered by someone else.', 'Remove or replace the link. If it is your own domain, renew it or restore its DNS.'),
  rule('links.unreachable', 'medium', 'Link could not be reached', 'The connection failed (refused, TLS error, or an address the runner may not reach).', 'Check the target address and its certificate; replace the link if it is wrong.'),
  rule('links.redirect.chain', 'low', 'Link goes through a redirect chain', 'Each redirect hop adds latency and dilutes link signals; long chains often end somewhere unintended.', 'Link straight to the final URL.'),
  rule('links.redirect.to_http', 'medium', 'HTTPS page links to an HTTP URL', 'Visitors leave HTTPS, which can trigger browser warnings and exposes them to interception.', 'Change the link to https:// if the target supports it.'),
  rule('links.redirect.start', 'info', 'Start URL redirects', 'The address you asked to check redirects; the crawl used the final address.', 'Use the final address in your configuration and links.'),
  rule('links.sitemap.stale', 'low', 'Sitemap lists a URL that does not return 200', 'Search engines waste crawl budget on sitemap entries that error or redirect.', 'Remove the entry or replace it with the URL that now holds the content.'),
  rule('links.orphan', 'info', 'Page is in the sitemap but no crawled page links to it', 'Orphan pages are hard for visitors to find and get less weight from search engines.', 'Link to it from a relevant page, or remove it from the sitemap if it is retired.'),
  rule('links.soft_404', 'medium', 'Page says "not found" but returns 200', 'Search engines may index an error page, and monitoring sees it as healthy.', 'Return a real 404 (or 410) status for missing content.'),
  rule('links.canonical.broken', 'medium', 'Canonical URL redirects or does not return 200', 'Search engines may ignore a canonical that redirects or errors, or drop the page.', 'Point rel=canonical at the final, live, preferred URL of this page.'),
  rule('links.scheme.invalid', 'low', 'Phone, text or email link that cannot work', 'A tel:, sms: or mailto: link opens the visitor\'s phone or mail app with what follows it. When that is not a number or an address, tapping it does nothing or dials the wrong thing.', 'Write the number in international form with digits only (tel:+442079460000) and the address as it is (mailto:name@example.com). Keep words and spaces for the link\'s text.'),
  rule('links.device.response_differs', 'medium', 'Page answers a phone or a desktop browser differently', 'The same address gave one kind of visitor a working page and another an error. It is usually a redirect for phones to an address that no longer exists, or a rule on the server that turns some browsers away.', 'Open the address in that kind of browser and follow where it goes. Fix or remove the redirect, or the server rule, that sends it somewhere broken.'),
  rule('links.app.association_invalid', 'medium', 'App link file is missing or wrong', 'Links that should open your app need a file the phone fetches from your site: apple-app-site-association for iOS, assetlinks.json for Android. When it is missing, not valid JSON, redirected or served as the wrong type, the phone ignores it and the links open in the browser.', 'Serve the file at /.well-known/ with status 200, no redirect, as application/json, with the content Apple or Google documents for it.'),
  rule('links.host_rate_limited', 'info', 'A host kept rate limiting the crawl', 'Some links on this host could not be checked; they are not reported as broken.', 'Allow WebtraxBot a higher rate (see webtrax.dev/bot), or lower the crawl rate.'),
] satisfies RuleMeta[]

/** Why a tel:, sms: or mailto: link cannot work, or null when it can. */
export function schemeProblem(href: string): string | null {
  const m = /^\s*(tel|sms|mailto):(.*)$/is.exec(href)
  if (!m) return null
  const scheme = m[1]!.toLowerCase()
  let rest = m[2]!.trim()
  try { rest = decodeURIComponent(rest) } catch { return 'is not a valid address (bad % encoding)' }
  rest = rest.split('?')[0]!.trim()
  if (scheme === 'mailto') {
    // An empty mailto: opens a blank message, which is allowed. Several addresses are separated by commas.
    if (rest === '') return null
    const bad = rest.split(',').map((a) => a.trim()).find((a) => !/^[^\s@<>(),;:"]+@[^\s@<>(),;:"]+\.[^\s@<>(),;:".]{2,}$/.test(a))
    return bad === undefined ? null : `"${bad.slice(0, 60)}" is not an email address`
  }
  const number = rest.split(';')[0]!.trim()
  if (number === '') return scheme === 'sms' ? null : 'has no number'
  // RFC 3966: digits, an optional leading +, and the visual separators - . ( ). Several sms: numbers are separated by commas.
  for (const n of number.split(',')) {
    if (/[a-z]/i.test(n) && !/^[\d+*#\-.() ]*$/.test(n)) return `"${n.trim().slice(0, 40)}" has letters in the number`
    if (/\s/.test(n.trim())) return `"${n.trim().slice(0, 40)}" has spaces in the number`
    if (!/^\+?[\d\-.()*#]+$/.test(n.trim())) return `"${n.trim().slice(0, 40)}" is not a phone number`
    if ((n.match(/\d/g) ?? []).length < 3) return `"${n.trim().slice(0, 40)}" has too few digits`
  }
  return null
}

const looksHtml = (contentType: string | undefined, body: string) => /\bhtml\b/i.test(contentType ?? '') || /^\s*<(!doctype|html)\b/i.test(body)

/** What is wrong with an app association file's body and headers; empty when it is fine. `kind` picks the format. */
export function associationProblems(kind: 'apple' | 'android', o: { body?: string | undefined; contentType?: string | undefined; redirected: boolean }): string[] {
  const problems: string[] = []
  if (o.redirected) problems.push('is served through a redirect, which phones do not follow')
  if (!/^application\/(json|pkcs7-mime)\b/i.test(o.contentType ?? '')) problems.push(`is served as ${o.contentType ? o.contentType.split(';')[0] : 'no content type'}, not application/json`)
  let json: unknown
  try { json = JSON.parse(o.body ?? '') } catch { return [...problems, 'is not valid JSON'] }
  if (kind === 'apple') {
    const j = json as { applinks?: { details?: unknown; apps?: unknown }; webcredentials?: unknown; appclips?: unknown; activitycontinuation?: unknown } | null
    if (!j || typeof j !== 'object' || Array.isArray(j)) problems.push('is not a JSON object')
    else if (!j.applinks && !j.webcredentials && !j.appclips && !j.activitycontinuation) problems.push('names no service (applinks, webcredentials, appclips)')
    else if (j.applinks && !Array.isArray(j.applinks.details) && (typeof j.applinks.details !== 'object' || j.applinks.details === null)) problems.push('has applinks without details')
  } else {
    if (!Array.isArray(json)) problems.push('is not a JSON list of statements')
    else if (json.some((x) => !x || typeof x !== 'object' || !Array.isArray((x as { relation?: unknown }).relation) || typeof (x as { target?: { namespace?: unknown } }).target?.namespace !== 'string')) problems.push('has a statement without a relation list and a target namespace')
  }
  return problems
}

/** Pages checked as a phone and as a desktop browser, and bot-refused links checked again, per crawl. */
export const DEVICE_SAMPLE = 10
export const BOT_WALL_SAMPLE = 20
const working = (o: { status: number | null; error?: unknown }) => o.status !== null && o.status < 400 && !o.error
const refusedStatus = (s: number | null) => s === 401 || s === 403 || s === 406 || s === 429 || s === 503
/** Pages that declare an Android app link, per crawl. */
const androidLinks = new WeakMap<SuiteCtx, string>()

/**
 * An error page announces itself at the start of its title or main heading
 * ("404", "Page not found", "Error 404 - Shop"). Matching anywhere would flag
 * articles about errors ("How to fix a 404"), so only the start counts.
 */
const SOFT_404 = /^\s*(404\b|error\s*404\b|(oops[!,.]?\s*)?(page\s+)?not\s+found\b|(this\s+|the\s+)?page\s+((does\s+not|doesn['’]t)\s+exist|(cannot|can['’]t|could\s+not|couldn['’]t)\s+be\s+found)|sorry,?\s+(this|that|the)\s+page)/i
const isErrorText = (text: string) => SOFT_404.test(text) || SOFT_404.test(text.split(/\s[|·–—-]\s/)[0] ?? '')
const isRedirect = (s: number | null) => s !== null && s >= 300 && s < 400

/** Follows a redirect the crawl stopped at a known page through that page's outcome. */
export function resolveOutcome(site: SiteState, target: string): { outcome: LinkOutcome; hops: number; finalUrl: string } | null {
  let outcome = site.links.get(target)
  if (!outcome) return null
  let hops = outcome.chain.length
  const seen = new Set([target])
  for (;;) {
    const next = normaliseUrl(outcome.finalUrl)
    if (!isRedirect(outcome.status) || !next || seen.has(next)) break
    const after = site.links.get(next)
    if (!after) break
    seen.add(next)
    hops += after.chain.length
    outcome = after
  }
  return { outcome, hops, finalUrl: outcome.finalUrl }
}

const evidenceOf = (o: LinkOutcome, finalUrl: string, target: string) => ({
  ...(o.status !== null ? { status: o.status } : {}),
  ...(o.error ? { error: o.error } : {}),
  ...(normaliseUrl(finalUrl) !== target ? { final_url: finalUrl } : {}),
})

export const linksSuite: CheckSuite = {
  id: 'links',
  version: '1.0.0',
  requires: ['http'],
  rules: LINK_RULES,

  async onPage(ctx, page) {
    if (page.outcome.status !== 200) return
    const h1 = page.doc.$('h1').first().text().trim()
    if (isErrorText(page.doc.title ?? '') || isErrorText(h1)) await ctx.emit({ rule_id: 'links.soft_404', url: page.url, evidence: { title: page.doc.title ?? '', h1: h1.slice(0, 200) } })

    // Links that open the phone or mail app: one finding per broken link text per page.
    const seen = new Set<string>()
    for (const link of page.doc.links) {
      const problem = schemeProblem(link.href)
      const href = link.href.trim().slice(0, 200)
      if (!problem || seen.has(href)) continue
      seen.add(href)
      await ctx.emit({ rule_id: 'links.scheme.invalid', url: page.url, evidence_key: href, title: `${href.split(':')[0]!.toLowerCase()}: link ${problem}`, evidence: { href, ...(link.text ? { link_text: link.text } : {}) } })
    }
    if (!androidLinks.has(ctx) && page.doc.$('link[rel="alternate" i][href^="android-app://" i]').length) androidLinks.set(ctx, page.url)
  },

  async onSite(ctx, site) {
    const requested = normaliseUrl(site.requestedStartUrl)
    if (requested && requested !== site.startUrl) await ctx.emit({ rule_id: 'links.redirect.start', url: requested, evidence: { to: site.startUrl } })

    const linkedFromPages = new Set<string>()
    for (const edge of site.edges) {
      const resolved = resolveOutcome(site, edge.to)
      if (edge.kind === 'link') linkedFromPages.add(edge.to)
      if (!resolved) continue
      const { outcome, hops, finalUrl } = resolved
      const problem = linkProblem(outcome)

      if (edge.kind === 'sitemap') {
        if (problem || outcome.status !== 200 || hops > 0) {
          await ctx.emit({ rule_id: 'links.sitemap.stale', url: edge.to, source_url: edge.from, evidence: { ...evidenceOf(outcome, finalUrl, edge.to), hops } })
        }
        continue
      }
      if (edge.kind === 'canonical') {
        // A canonical must name the final URL itself: one that redirects is usually ignored by search engines.
        if (problem || outcome.status !== 200 || hops > 0) await ctx.emit({ rule_id: 'links.canonical.broken', url: edge.to, source_url: edge.from, evidence: { ...evidenceOf(outcome, finalUrl, edge.to), ...(hops > 0 ? { redirects: hops } : {}) } })
        continue
      }

      if (problem) {
        const ruleId = problem === 'http' ? (outcome.internal ? 'links.broken.internal' : 'links.broken.external')
          : problem === 'timeout' ? 'links.timeout' : problem === 'dns' ? 'links.dns_failure' : 'links.unreachable'
        await ctx.emit({ rule_id: ruleId, url: edge.to, source_url: edge.from, evidence: { ...evidenceOf(outcome, finalUrl, edge.to), ...(edge.text ? { link_text: edge.text } : {}) } })
      } else if (hops > 2) {
        await ctx.emit({ rule_id: 'links.redirect.chain', url: edge.to, source_url: edge.from, evidence: { hops, final_url: finalUrl } })
      }
      if (edge.from.startsWith('https://') && edge.to.startsWith('http://')) {
        await ctx.emit({ rule_id: 'links.redirect.to_http', url: edge.to, source_url: edge.from })
      }
    }

    // Orphans: in a sitemap, crawled fine, but no crawled page links to them.
    for (const edge of site.edges) {
      if (edge.kind !== 'sitemap' || edge.to === site.startUrl || linkedFromPages.has(edge.to)) continue
      const resolved = resolveOutcome(site, edge.to)
      if (resolved?.outcome.status === 200) await ctx.emit({ rule_id: 'links.orphan', url: edge.to, evidence: { sitemap: edge.from } })
    }

    // The same pages as a phone and as a desktop browser: an error for one where another is served.
    const sample = [...site.pages.values()]
      .filter((p) => p.status === 200 && p.url.startsWith(`${site.origin}/`))
      .sort((a, b) => a.depth - b.depth || (a.url < b.url ? -1 : 1))
      .slice(0, typeof ctx.config.device_sample === 'number' ? ctx.config.device_sample : DEVICE_SAMPLE)
    for (const p of sample) {
      const phone = await ctx.requestAs(p.url, 'phone')
      const desktop = await ctx.requestAs(p.url, 'desktop')
      const failing = ([['phone', phone], ['desktop', desktop]] as const).filter(([, o]) => !working(o) && o.error !== 'rate_limited' && o.status !== 429)
      if (!failing.length) continue
      const answer = (o: typeof phone) => ({ ...(o.status !== null ? { status: o.status } : {}), ...(o.error ? { error: o.error } : {}), ...(normaliseUrl(o.finalUrl) !== p.url ? { final_url: o.finalUrl } : {}) })
      await ctx.emit({
        rule_id: 'links.device.response_differs', url: p.url, evidence_key: failing.map(([d]) => d).join('+'),
        title: failing.length === 2 ? 'Page works for Webtrax and fails for phone and desktop browsers' : `Page fails for a ${failing[0]![0]} browser`,
        evidence: { webtrax: { status: 200 }, phone: answer(phone), desktop: answer(desktop) },
      })
    }

    // Links only Webtrax was refused: a bot wall, not a broken link. Said once per link, as information.
    const refused = [...new Set(site.edges.filter((e) => e.kind === 'link').map((e) => e.to))]
      .map((url) => site.links.get(url)).filter((o): o is LinkOutcome => !!o && refusedStatus(o.status))
      .slice(0, BOT_WALL_SAMPLE)
    for (const o of refused) {
      const desktop = await ctx.requestAs(o.url, 'desktop')
      if (!working(desktop)) continue
      await ctx.emit({
        rule_id: 'links.device.response_differs', url: o.url, evidence_key: 'bot', severity: 'info',
        title: 'Link answers browsers but refuses Webtrax',
        evidence: { webtrax: { status: o.status }, desktop: { status: desktop.status }, note: 'The site turns automated checks away, so this link is probably not broken for visitors.' },
      })
    }

    // App links: the files phones fetch to open links in an app.
    for (const [kind, path] of [['apple', '/.well-known/apple-app-site-association'], ['android', '/.well-known/assetlinks.json']] as const) {
      const url = `${site.origin}${path}`
      const o = await ctx.text(url, 256 * 1024)
      const html = looksHtml(o.contentType, o.body ?? '')
      // A site that answers every path with its app's HTML has not declared anything.
      const present = o.status === 200 && !html && (o.body ?? '').trim() !== ''
      if (present) {
        const problems = associationProblems(kind, { body: o.body, contentType: o.contentType, redirected: o.chain.length > 0 || (normaliseUrl(o.finalUrl) ?? o.finalUrl) !== (normaliseUrl(url) ?? url) })
        if (problems.length) await ctx.emit({ rule_id: 'links.app.association_invalid', url, title: `${path.split('/').pop()} ${problems[0]}`, evidence: { problems } })
      } else if (kind === 'android' && androidLinks.has(ctx) && o.error === undefined && o.status !== null && o.status < 500 && o.status !== 429) {
        await ctx.emit({ rule_id: 'links.app.association_invalid', url, title: 'Pages declare an Android app link, and assetlinks.json is missing', evidence: { problems: [html ? 'is an HTML page, not the file' : `answers ${o.status}`], declared_on: androidLinks.get(ctx) } })
      }
    }

    // Hosts that stayed rate limited: one info finding per host.
    const limited = new Map<string, number>()
    for (const o of site.links.values()) if (o.error === 'rate_limited') limited.set(new URL(o.url).origin, (limited.get(new URL(o.url).origin) ?? 0) + 1)
    for (const [origin, count] of limited) await ctx.emit({ rule_id: 'links.host_rate_limited', url: `${origin}/`, evidence: { urls: count } })
  },
}

export default linksSuite
