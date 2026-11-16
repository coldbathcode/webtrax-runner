/**
 * SEO basics (C05.4; the minimal set from plan/BUILD-PLAN.md): titles, meta
 * descriptions, headings, noindex and language, on every crawled page that
 * returned 200. Duplicate titles are found after the crawl. The full
 * technical SEO suite (canonicals, hreflang, structured data …) is C06.3.
 */
import type { CheckSuite } from '@webtrax/engine'
import type { RuleMeta } from '@webtrax/protocol'

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
] satisfies RuleMeta[]

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
    if (/\bnoindex\b/i.test(`${robotsMeta},${robotsHeader}`)) await ctx.emit({ rule_id: 'seo.noindex', url, evidence: { ...(robotsMeta ? { meta: robotsMeta } : {}), ...(robotsHeader ? { header: robotsHeader } : {}) } })
    if (!$('html').attr('lang')?.trim()) await ctx.emit({ rule_id: 'seo.lang.missing', url })
  },

  async onSite(ctx, site) {
    const byTitle = new Map<string, string[]>()
    for (const page of site.pages.values()) {
      if (page.status !== 200 || !page.title) continue
      const key = page.title.trim().toLowerCase()
      const urls = byTitle.get(key) ?? []
      const final = page.final_url
      if (!urls.includes(final)) urls.push(final)
      byTitle.set(key, urls)
    }
    for (const [title, urls] of byTitle) {
      if (urls.length < 2) continue
      const sorted = [...urls].sort()
      for (const url of sorted) await ctx.emit({ rule_id: 'seo.title.duplicate', url, evidence_key: title, evidence: { title, pages: sorted.length, others: sorted.filter((u) => u !== url).slice(0, 5) } })
    }
  },
}

export default seoSuite
