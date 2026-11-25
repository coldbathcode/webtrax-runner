/**
 * SEO basics (C05.4; the minimal set from plan/BUILD-PLAN.md): titles, meta
 * descriptions, headings, noindex and language, on every crawled page that
 * returned 200. Duplicate titles are found after the crawl.
 *
 * C06.3 (first slice, plan/06-check-suites/seo-a11y-content.md §1): duplicate
 * meta descriptions, several or cross-site canonicals, social preview tags,
 * skipped heading levels, nofollow on internal links, hreflang codes and
 * return links, and sitemap URLs that robots.txt blocks for search engines.
 *
 * C06.3 (second slice): canonicals that name a noindex page, sitemap URLs
 * whose canonical is another URL, the bare domain and www. both answering as
 * the site, pages more than four clicks from the start page, descriptions
 * search results cut off, and social preview images that do not load.
 */
import { linkProblem, parseRobots, registrableDomain, type CheckSuite, type SuiteCtx } from '@webtrax/engine'
import { normaliseUrl, type RuleMeta } from '@webtrax/protocol'

const rule = (id: string, severity: RuleMeta['severity'], title: string, why: string, fix: string): RuleMeta => ({
  id, suite: 'seo', title, version: 1, severity, why, fix, docs_slug: id.replace(/[._]/g, '-'), tags: [],
})

export const TITLE_MAX = 70
export const DESCRIPTION_MAX = 160
/** Clicks from the start page beyond which a page is deep. */
export const MAX_CLICKS = 4
/** Distinct social preview images checked per run. */
export const OG_IMAGE_CHECKS = 20

export const SEO_RULES = [
  rule('seo.title.missing', 'medium', 'Page has no title', 'The title is the headline in search results and browser tabs; without one, search engines make one up.', 'Add a unique, descriptive <title> to the page.'),
  rule('seo.title.too_long', 'low', `Title is longer than ${TITLE_MAX} characters`, 'Search results cut long titles off, often before the words that matter.', `Keep titles under about ${TITLE_MAX} characters, with the key words first.`),
  rule('seo.title.duplicate', 'low', 'Several pages share the same title', 'Search engines struggle to tell the pages apart and may show the wrong one.', 'Give each page a title that says what is distinct about it.'),
  rule('seo.meta_description.missing', 'low', 'Page has no meta description', 'Search engines fall back to a snippet of page text, which is often a poor summary.', 'Add a <meta name="description"> of one or two sentences.'),
  rule('seo.h1.missing', 'low', 'Page has no h1 heading', 'The main heading tells readers, screen readers and search engines what the page is about.', 'Add one <h1> that states the page\'s topic.'),
  rule('seo.h1.multiple', 'info', 'Page has more than one h1 heading', 'Several top-level headings blur what the page is mainly about.', 'Keep one <h1> and use <h2>–<h6> for sections.'),
  rule('seo.noindex', 'medium', 'Page asks search engines not to index it', 'A noindex on a public page removes it from search results; it is often left over from staging.', 'Remove noindex from the robots meta tag or X-Robots-Tag header, unless the page should stay out of search.'),
  rule('seo.lang.missing', 'low', 'Page does not declare its language', 'Search engines and screen readers rely on <html lang> to handle the text correctly.', 'Add a lang attribute, e.g. <html lang="en">.'),
  rule('seo.meta_description.duplicate', 'low', 'Several pages share the same meta description', 'Search results show the same summary for different pages, so people cannot tell which one they want.', 'Write a description for each page that says what is on that page.'),
  rule('seo.canonical.multiple', 'medium', 'Page names more than one canonical URL', 'With conflicting canonical tags (or a tag and a Link header that disagree), search engines ignore them all and pick a URL themselves.', 'Keep exactly one <link rel="canonical"> per page, and make any Link header name the same URL.'),
  rule('seo.canonical.cross_domain', 'medium', 'Canonical URL is on another site', 'A canonical on another domain tells search engines to index that site instead of this page. Right for syndicated copies, wrong almost everywhere else (often a staging or old domain left in a template).', 'Point the canonical at this page\'s own URL, unless the content really belongs to the other site.'),
  rule('seo.social.og_missing', 'low', 'Page has no social preview tags', 'Links shared in chat, social networks and AI assistants show a bare URL instead of a title, summary and image.', 'Add og:title, og:description and og:image meta tags (Open Graph) to the page.'),
  rule('seo.headings.skipped_level', 'low', 'Heading levels skip a step', 'A jump such as h2 to h4 breaks the outline that search engines and screen readers use to understand the page.', 'Use heading levels in order (h2, then h3), and style them with CSS rather than picking a level for its size.'),
  rule('seo.links.nofollow_internal', 'low', 'Internal links marked nofollow', 'rel="nofollow" on links to your own pages tells search engines not to follow them, so those pages get less weight or are not found.', 'Remove rel="nofollow" from links to your own site; use noindex on pages that should stay out of search.'),
  rule('seo.hreflang.invalid', 'medium', 'Language alternates (hreflang) are wrong', 'Search engines ignore hreflang annotations with invalid codes or without return links, so people may land on the wrong language version.', 'Use codes such as "en", "en-GB" or "x-default", include the page itself, and make each alternate link back to this page.'),
  rule('seo.canonical.to_noindex', 'high', 'Canonical URL names a page that asks not to be indexed', 'The page says another URL is the one to index, and that URL says not to index it: search engines may drop both from results.', 'Point the canonical at an indexable page (usually this page itself), or remove noindex from the page it names.'),
  rule('seo.canonical.sitemap_mismatch', 'medium', 'Sitemap lists a URL whose canonical is another URL', 'The sitemap asks search engines to index this URL while the page says a different one is the real one, so they get two answers and may pick neither.', 'List the canonical URL in the sitemap instead, or make the page its own canonical.'),
  rule('seo.host.not_canonicalised', 'medium', 'The site answers on both the bare domain and www.', 'example.com and www.example.com both serve the site without one redirecting to the other or naming it as canonical, so search engines see two copies of every page and split their ranking.', 'Redirect one host to the other with a 301 (and keep using the one you chose in links and the sitemap), or add a canonical on every page that names the chosen host.'),
  rule('seo.links.deep', 'low', 'Page is more than four clicks from the start page', 'Pages that take many clicks to reach are crawled less often, rank lower and are harder for people to find.', 'Link to the page from a higher level (a section index, the menu, related pages), so it is at most four clicks from the start page.'),
  rule('seo.meta_description.too_long', 'info', `Meta description is longer than ${DESCRIPTION_MAX} characters`, 'Search results cut long descriptions off, often before the sentence that would make someone click. Search engines often write their own snippet anyway, so this is advice, not counted in the score.', `Keep the description under about ${DESCRIPTION_MAX} characters, with what the page offers first.`),
  rule('seo.social.og_image_broken', 'medium', 'Social preview image does not load', 'Links to the page shared in chat, social networks and AI assistants show a blank or broken preview instead of the image.', 'Make og:image an absolute https:// URL of an image that loads (at least 1200 x 630 pixels is the common size), or fix the image at that address.'),
  rule('seo.robots.blocks_sitemap_url', 'high', 'Sitemap lists a page that robots.txt blocks', 'You ask search engines to index the page in the sitemap but forbid them to crawl it in robots.txt, so it cannot be indexed properly.', 'Remove the page from the sitemap, or change the Disallow rule in robots.txt that matches it.'),
] satisfies RuleMeta[]

/** BCP 47 as hreflang uses it: language, optional script, optional region; or x-default. */
const HREFLANG = /^(x-default|[a-z]{2,3}(-[a-z]{4})?(-([a-z]{2}|\d{3}))?)$/i
const hostKey = (u: string) => {
  try {
    return new URL(u).hostname.replace(/^www\./, '').toLowerCase()
  } catch {
    return null
  }
}
/**
 * Hosts whose pages normally name production as canonical: a local build or a
 * deploy preview (checked on pull requests). The cross-site canonical rule is
 * about production pages, so it stays quiet there.
 */
export function previewOrLocalHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, '')
  return h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h === '::1' || /^127\./.test(h) || /^10\./.test(h) || /^192\.168\./.test(h) || /^172\.(1[6-9]|2\d|3[01])\./.test(h)
    || /(^|\.)(vercel\.app|netlify\.app|pages\.dev|onrender\.com|fly\.dev|amplifyapp\.com|web\.app|firebaseapp\.com|ngrok\.io|ngrok-free\.app)$/.test(h)
}
interface Seen { descriptions: Map<string, string[]>; alternates: Map<string, { lang: string; href: string }[]>; noindex: Set<string>; ogImages: Map<string, string[]> }
const seen = new WeakMap<SuiteCtx, Seen>()
const stateFor = (ctx: SuiteCtx): Seen => {
  let s = seen.get(ctx)
  if (!s) seen.set(ctx, (s = { descriptions: new Map(), alternates: new Map(), noindex: new Set(), ogImages: new Map() }))
  return s
}

export const seoSuite: CheckSuite = {
  id: 'seo',
  version: '1.0.0',
  requires: ['http'],
  rules: SEO_RULES,

  async onPage(ctx, page) {
    if (page.outcome.status !== 200) return
    const { $, title } = page.doc
    const url = page.url
    if (!title) await ctx.emit({ rule_id: 'seo.title.missing', url })
    else if (title.length > TITLE_MAX) await ctx.emit({ rule_id: 'seo.title.too_long', url, evidence: { title: title.slice(0, 300), length: title.length } })
    if (!$('meta[name="description" i]').attr('content')?.trim()) await ctx.emit({ rule_id: 'seo.meta_description.missing', url })
    const h1 = $('h1').length
    if (h1 === 0) await ctx.emit({ rule_id: 'seo.h1.missing', url })
    else if (h1 > 1) await ctx.emit({ rule_id: 'seo.h1.multiple', url, evidence: { count: h1 } })
    const robotsMeta = $('meta[name="robots" i], meta[name="webtraxbot" i]').map((_, el) => $(el).attr('content') ?? '').get().join(',')
    const robotsHeader = page.outcome.headers?.['x-robots-tag'] ?? ''
    const noindex = /\bnoindex\b/i.test(`${robotsMeta},${robotsHeader}`)
    if (noindex) await ctx.emit({ rule_id: 'seo.noindex', url, evidence: { ...(robotsMeta ? { meta: robotsMeta } : {}), ...(robotsHeader ? { header: robotsHeader } : {}) } })
    if (!$('html').attr('lang')?.trim()) await ctx.emit({ rule_id: 'seo.lang.missing', url })

    const state = stateFor(ctx)
    const own = normaliseUrl(page.outcome.finalUrl || url) ?? url
    const description = $('meta[name="description" i]').attr('content')?.trim()
    if (noindex) state.noindex.add(own)
    if (description && description.length > DESCRIPTION_MAX) await ctx.emit({ rule_id: 'seo.meta_description.too_long', url, evidence: { description: description.slice(0, 300), length: description.length } })
    if (description) {
      const key = description.toLowerCase().replace(/\s+/g, ' ')
      const list = state.descriptions.get(key) ?? []
      if (!list.includes(own)) list.push(own)
      state.descriptions.set(key, list)
    }

    // Canonicals: tags and the Link header, as absolute URLs.
    const resolve = (href: string) => {
      try {
        return new URL(href, page.doc.baseUrl).href
      } catch {
        return null
      }
    }
    const tags = $('link[rel~="canonical" i]').map((_, el) => $(el).attr('href')?.trim() ?? '').get().filter(Boolean).map(resolve).filter((u): u is string => !!u)
    const header = /<([^>]+)>\s*;\s*rel="?canonical"?/i.exec(page.outcome.headers?.link ?? '')?.[1]
    const canonicals = [...new Set([...tags, ...(header ? [resolve(header)].filter((u): u is string => !!u) : [])].map((u) => normaliseUrl(u) ?? u))]
    if (canonicals.length > 1) await ctx.emit({ rule_id: 'seo.canonical.multiple', url, evidence: { canonicals: canonicals.slice(0, 5) } })
    else if (canonicals.length === 1 && hostKey(canonicals[0]!) !== hostKey(url) && !previewOrLocalHost(new URL(url).hostname)) await ctx.emit({ rule_id: 'seo.canonical.cross_domain', url, evidence: { canonical: canonicals[0] } })

    const og = ['og:title', 'og:description', 'og:image'].filter((p) => !$(`meta[property="${p}" i]`).attr('content')?.trim())
    const image = $('meta[property="og:image" i]').attr('content')?.trim()
    const imageUrl = image ? resolve(image) : null
    if (imageUrl && /^https?:/i.test(imageUrl) && !noindex) {
      const list = state.ogImages.get(imageUrl) ?? []
      if (!list.includes(own)) list.push(own)
      state.ogImages.set(imageUrl, list)
    }
    // A page kept out of search is rarely shared either (an app's sign-in page).
    if (og.length === 3 && !noindex) await ctx.emit({ rule_id: 'seo.social.og_missing', url, evidence: { missing: og } })

    // Heading levels: the first skip (h2 → h4) is enough to report.
    let last = 0
    for (const el of $('h1, h2, h3, h4, h5, h6').toArray()) {
      const level = Number(el.tagName.slice(1))
      if (last && level > last + 1) {
        await ctx.emit({ rule_id: 'seo.headings.skipped_level', url, evidence: { from: `h${last}`, to: `h${level}`, heading: $(el).text().trim().slice(0, 120) } })
        break
      }
      last = level
    }

    const nofollow = page.doc.links.filter((l) => /\bnofollow\b/i.test(l.rel ?? '')).map((l) => resolve(l.href)).filter((u): u is string => !!u && new URL(u).origin === ctx.origin)
    if (nofollow.length) await ctx.emit({ rule_id: 'seo.links.nofollow_internal', url, evidence: { links: nofollow.length, examples: [...new Set(nofollow)].slice(0, 5) } })

    // hreflang: codes now, return links after the crawl.
    const alternates = $('link[rel~="alternate" i][hreflang]').map((_, el) => ({ lang: ($(el).attr('hreflang') ?? '').trim(), href: resolve($(el).attr('href') ?? '') })).get()
      .filter((a): a is { lang: string; href: string } => !!a.href)
    if (alternates.length) {
      const bad = alternates.filter((a) => !HREFLANG.test(a.lang)).map((a) => a.lang)
      const self = alternates.some((a) => (normaliseUrl(a.href) ?? a.href) === own)
      const problems = [...(bad.length ? [`invalid codes: ${[...new Set(bad)].slice(0, 5).join(', ')}`] : []), ...(self ? [] : ['the page does not list itself'])]
      if (problems.length) await ctx.emit({ rule_id: 'seo.hreflang.invalid', url, evidence_key: 'page', evidence: { problems } })
      state.alternates.set(own, alternates.map((a) => ({ lang: a.lang, href: normaliseUrl(a.href) ?? a.href })))
    }
  },

  async onSite(ctx, site) {
    // Pages that name the same canonical URL are one page (/waitlist and /waitlist?v=b), not duplicates.
    const canonicalOf = new Map(site.edges.filter((e) => e.kind === 'canonical').map((e) => [e.from, e.to]))
    const byTitle = new Map<string, string[]>()
    for (const page of site.pages.values()) {
      if (page.status !== 200 || !page.title) continue
      const key = page.title.trim().toLowerCase()
      const urls = byTitle.get(key) ?? []
      const own = normaliseUrl(page.final_url) ?? page.final_url
      const final = canonicalOf.get(own) ?? own
      if (!urls.includes(final)) urls.push(final)
      byTitle.set(key, urls)
    }
    for (const [title, urls] of byTitle) {
      if (urls.length < 2) continue
      const sorted = [...urls].sort()
      for (const url of sorted) await ctx.emit({ rule_id: 'seo.title.duplicate', url, evidence_key: title, evidence: { title, pages: sorted.length, others: sorted.filter((u) => u !== url).slice(0, 5) } })
    }

    const state = stateFor(ctx)
    for (const [description, list] of state.descriptions) {
      const urls = [...new Set(list.map((u) => canonicalOf.get(u) ?? u))].sort()
      if (urls.length < 2) continue
      for (const url of urls) await ctx.emit({ rule_id: 'seo.meta_description.duplicate', url, evidence_key: description.slice(0, 200), evidence: { description: description.slice(0, 300), pages: urls.length, others: urls.filter((u) => u !== url).slice(0, 5) } })
    }

    // Canonicals that name a noindex page, and sitemap URLs whose page names another canonical.
    for (const [from, to] of canonicalOf) {
      if (to === from) continue
      const target = site.pages.get(to)
      const final = target ? (normaliseUrl(target.final_url) ?? target.final_url) : to
      if (state.noindex.has(to) || state.noindex.has(final)) await ctx.emit({ rule_id: 'seo.canonical.to_noindex', url: from, evidence: { canonical: to } })
    }
    const inSitemap = new Map<string, string>()
    for (const e of site.edges) if (e.kind === 'sitemap' && !inSitemap.has(e.to)) inSitemap.set(e.to, e.from)
    for (const [listed, sitemap] of inSitemap) {
      const page = site.pages.get(listed)
      const own = page ? (normaliseUrl(page.final_url) ?? page.final_url) : listed
      const canonical = canonicalOf.get(own)
      // A listed URL that redirects is links.sitemap.stale's finding; this is a page that answers and points elsewhere.
      if (page?.status === 200 && own === listed && canonical && canonical !== own) await ctx.emit({ rule_id: 'seo.canonical.sitemap_mismatch', url: listed, evidence: { canonical, sitemap } })
    }

    // Click depth: the fewest links from the start page, over the pages the crawl fetched.
    const finalOf = (u: string) => { const p = site.pages.get(u); return p ? (normaliseUrl(p.final_url) ?? p.final_url) : u }
    const html = new Set([...site.pages.values()].filter((p) => p.status === 200 && p.title !== undefined).map((p) => normaliseUrl(p.final_url) ?? p.final_url))
    const out = new Map<string, string[]>()
    for (const e of site.edges) if (e.kind === 'link') (out.get(e.from) ?? out.set(e.from, []).get(e.from)!).push(e.to)
    const start = finalOf(site.startUrl)
    const parent = new Map<string, string | null>([[start, null]])
    const clicks = new Map<string, number>([[start, 0]])
    for (const queue = [start], i = { n: 0 }; i.n < queue.length; i.n++) {
      const at = queue[i.n]!
      for (const raw of out.get(at) ?? []) {
        const next = finalOf(raw)
        if (clicks.has(next) || !html.has(next) || !next.startsWith(`${site.origin}/`)) continue
        clicks.set(next, clicks.get(at)! + 1)
        parent.set(next, at)
        queue.push(next)
      }
    }
    const path = (u: string) => (u.startsWith(`${site.origin}/`) ? u.slice(site.origin.length) : u)
    // Only from a crawl that saw the whole site: a page limit can leave out the shorter route (sitemap pages use the
    // budget first), so a partial crawl's click counts are only upper bounds.
    for (const [url, n] of site.incomplete ? [] : [...clicks].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
      if (n <= MAX_CLICKS) continue
      const route: string[] = []
      for (let at: string | null | undefined = url; at; at = parent.get(at)) route.unshift(path(at))
      await ctx.emit({ rule_id: 'seo.links.deep', url, evidence: { clicks: n, route: route.length > 8 ? [...route.slice(0, 3), '…', ...route.slice(-4)] : route } })
    }

    // Social preview images, each checked once.
    for (const [image, pages] of [...state.ogImages].sort((a, b) => (a[0] < b[0] ? -1 : 1)).slice(0, OG_IMAGE_CHECKS)) {
      const known = site.links.get(normaliseUrl(image) ?? image)
      const outcome = known ?? (await ctx.request(image))
      const problem = linkProblem(outcome)
      if (!problem) continue
      const sorted = [...pages].sort()
      await ctx.emit({
        rule_id: 'seo.social.og_image_broken', url: image, source_url: sorted[0]!,
        evidence: { ...(outcome.status !== null ? { status: outcome.status } : {}), ...(outcome.error ? { error: outcome.error } : {}), pages: sorted.length, examples: sorted.slice(0, 5).map(path) },
      })
    }

    // The bare domain and www. both answering as the site (one request to the other host's home page).
    const host = new URL(site.origin).hostname
    const domain = registrableDomain(host)
    if (domain && !previewOrLocalHost(host) && (host === domain || host === `www.${domain}`)) {
      const other = `${new URL(site.origin).protocol}//${host === domain ? `www.${domain}` : domain}/`
      const o = await ctx.request(other)
      // Fine when it redirects (any 3xx), does not answer, or names a canonical on this host.
      if (o.status === 200 && !o.error) {
        const tag = o.body ? /<link\b[^>]*\brel=["']?canonical\b[^>]*>/i.exec(o.body)?.[0] : undefined
        const href = tag ? /\bhref=["']?([^"'\s>]+)/i.exec(tag)?.[1] : undefined
        let canonical: URL | null = null
        try { canonical = href ? new URL(href, other) : null } catch { canonical = null }
        if (canonical?.hostname !== host) await ctx.emit({ rule_id: 'seo.host.not_canonicalised', url: other, evidence: { status: 200, site: `${site.origin}/`, ...(canonical ? { canonical: canonical.href } : {}) } })
      }
    }

    // hreflang return links, between crawled pages only.
    for (const [from, alternates] of state.alternates) {
      const missing = alternates.filter((a) => a.href !== from && state.alternates.has(a.href) && !state.alternates.get(a.href)!.some((b) => b.href === from)).map((a) => a.href)
      if (missing.length) await ctx.emit({ rule_id: 'seo.hreflang.invalid', url: from, evidence_key: 'return', evidence: { problems: ['alternates do not link back'], pages: missing.slice(0, 5) } })
    }

    // Sitemap URLs that robots.txt blocks for search engines (Googlebot's reading of it).
    const listed = [...new Set(site.edges.filter((e) => e.kind === 'sitemap').map((e) => e.to))]
    if (listed.length) {
      const robotsUrl = `${site.origin}/robots.txt`
      const robots = await ctx.text(robotsUrl)
      if (robots.status === 200 && robots.body && !/\bhtml\b/i.test(robots.contentType ?? '')) {
        const rules = parseRobots(robotsUrl, robots.body, 'Googlebot')
        const blocked = listed.filter((u) => u.startsWith(`${site.origin}/`) && !rules.isAllowed(u))
        for (const url of blocked.slice(0, 50)) await ctx.emit({ rule_id: 'seo.robots.blocks_sitemap_url', url })
      }
    }
  },
}

export default seoSuite
