/**
 * SEO basics (C05.4; the minimal set from plan/BUILD-PLAN.md): titles, meta
 * descriptions, headings, noindex and language, on every crawled page that
 * returned 200. Duplicate titles are found after the crawl.
 *
 * C06.3 (first slice, plan/06-check-suites/seo-a11y-content.md §1): duplicate
 * meta descriptions, several or cross-site canonicals, social preview tags,
 * skipped heading levels, nofollow on internal links, hreflang codes and
 * return links, and sitemap URLs that robots.txt blocks for search engines.
 */
import { parseRobots, type CheckSuite, type SuiteCtx } from '@webtrax/engine'
import { normaliseUrl, type RuleMeta } from '@webtrax/protocol'

const rule = (id: string, severity: RuleMeta['severity'], title: string, why: string, fix: string): RuleMeta => ({
  id, suite: 'seo', title, version: 1, severity, why, fix, docs_slug: id.replace(/[._]/g, '-'), tags: [],
})

export const TITLE_MAX = 70

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
interface Seen { descriptions: Map<string, string[]>; alternates: Map<string, { lang: string; href: string }[]> }
const seen = new WeakMap<SuiteCtx, Seen>()
const stateFor = (ctx: SuiteCtx): Seen => {
  let s = seen.get(ctx)
  if (!s) seen.set(ctx, (s = { descriptions: new Map(), alternates: new Map() }))
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
