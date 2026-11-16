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
import { linkProblem, type CheckSuite, type LinkOutcome, type SiteState } from '@webtrax/engine'
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
  rule('links.host_rate_limited', 'info', 'A host kept rate limiting the crawl', 'Some links on this host could not be checked; they are not reported as broken.', 'Allow WebtraxBot a higher rate (see webtrax.dev/bot), or lower the crawl rate.'),
] satisfies RuleMeta[]

const SOFT_404 = /\b(404|page not found|not found|page doesn['’]t exist|page does not exist)\b/i
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
    const text = `${page.doc.title ?? ''} ${h1}`
    if (SOFT_404.test(text)) await ctx.emit({ rule_id: 'links.soft_404', url: page.url, evidence: { title: page.doc.title ?? '', h1: h1.slice(0, 200) } })
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

    // Hosts that stayed rate limited: one info finding per host.
    const limited = new Map<string, number>()
    for (const o of site.links.values()) if (o.error === 'rate_limited') limited.set(new URL(o.url).origin, (limited.get(new URL(o.url).origin) ?? 0) + 1)
    for (const [origin, count] of limited) await ctx.emit({ rule_id: 'links.host_rate_limited', url: `${origin}/`, evidence: { urls: count } })
  },
}

export default linksSuite
