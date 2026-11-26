/**
 * Content (C06.5, first slice; plan/06-check-suites/seo-a11y-content.md §3):
 * what a visitor reads, checked from the HTML alone, with no dictionary and
 * no AI:
 *
 * - placeholder text that was never replaced: lorem ipsum, "Click here to
 *   edit", "[insert …]", a template tag that reached the page unrendered
 *   (`{{ name }}`), and a value that printed as `undefined`, `NaN` or `null`;
 * - a copyright year that is behind this year (site-wide: one finding);
 * - a term from the site's own list of words not to use (`config.dictionary`);
 * - a "last updated" date more than 18 months old, on pages one click from
 *   the start page;
 * - a page that answers 200 with almost nothing to read (not a form page,
 *   a redirect stub or a noindex page);
 * - pages whose main text is the same, or nearly the same, as another's.
 *
 * Code samples are never read (`<code>`, `<pre>`, `<kbd>`, `<samp>`), so a
 * page that documents `{{ templates }}` or `undefined` is not reported.
 * Navigation, headers and footers do not count as a page's main text.
 */
import { visibleText, wordCount, type CheckSuite, type SuiteCtx } from '@webtrax/engine'
import type { RuleMeta } from '@webtrax/protocol'

const rule = (id: string, severity: RuleMeta['severity'], title: string, why: string, fix: string): RuleMeta => ({
  id, suite: 'content', title, version: 1, severity, why, fix, docs_slug: id.replace(/[._]/g, '-'), tags: ['content'],
})

export const CONTENT_RULES = [
  rule('content.placeholder', 'high', 'Placeholder text left on the page', 'Filler text, an unrendered template tag or a value that printed as "undefined" tells visitors the page was not finished or is broken, and search engines index it as written.', 'Replace the text with the real content, or fix the template or script that should have filled it in. The evidence quotes what was found.'),
  rule('content.copyright_stale', 'low', 'Copyright year is out of date', 'A footer that still shows an earlier year makes a site look unattended, which costs trust before a visitor has read anything.', 'Update the year, or print the current year from your template so it never falls behind. A range from the first year to the current one also works.'),
  rule('content.empty_page', 'medium', 'Page has almost no content', 'A page that loads but has next to nothing to read is a dead end for visitors and is treated as thin content by search engines. It is often a template without its data or a page that was never written.', 'Add the content the page is for, redirect it to a page that has it, or remove it and the links to it. If the content only appears with JavaScript, send it in the HTML.'),
  rule('content.dictionary', 'medium', 'A term from your list of words not to use', 'Your team listed this term as one the site should no longer use: an old product name, a retired price or wording you have moved on from. It is still on this page.', 'Replace it with the wording you listed, or reword the sentence. The list is `content.dictionary` in webtrax.yml, or Words not to use on the site\'s Settings tab in the app.'),
  rule('content.date_stale', 'info', 'Page says it was last updated long ago', 'A visible "last updated" date more than 18 months old, on a page linked from your home page, suggests the page may no longer be right, whether or not it is.', 'Review the page. If it is still correct, update the date; if not, bring it up to date or remove it.'),
  rule('content.duplicate', 'low', 'Pages with the same content', 'When several URLs carry the same text, search engines pick one and may pick the wrong one, links are split between them, and visitors land on copies.', 'Keep one page and redirect the others to it, or give each a canonical link to the one that should be listed. If the pages are meant to differ, give each its own text.'),
] satisfies RuleMeta[]

export const EMPTY_PAGE_WORDS = 20
/** Pages shorter than this are not compared with each other: short pages share most of their words by chance. */
export const DUPLICATE_MIN_WORDS = 80
/** Of 64 fingerprint bits, how many may differ for two texts to count as the same (about 95% alike). */
export const DUPLICATE_MAX_BITS = 3
const MAX_EVIDENCE_URLS = 10

const squash = (s: string) => s.replace(/\s+/g, ' ').trim()

// The text people read and its words: in the engine, so the SEO suite counts words the same way.
export { visibleText, wordCount }

export interface Placeholder { kind: 'lorem_ipsum' | 'editor_prompt' | 'insert_marker' | 'template_tag' | 'empty_value'; quote: string }

const quoteAround = (line: string, index: number, length: number) => {
  const start = Math.max(0, index - 30)
  const q = line.slice(start, index + length + 30)
  return `${start > 0 ? '…' : ''}${q}${index + length + 30 < line.length ? '…' : ''}`.slice(0, 160)
}

/**
 * Placeholder text in the visible text, at most one of each kind per page.
 * `loneValues: false` leaves out a block that is only "undefined", "NaN" or
 * "null": on a page about code that is a heading or a table cell, not a bug.
 */
export function findPlaceholders(text: string, opts: { loneValues?: boolean } = {}): Placeholder[] {
  const lone = opts.loneValues ?? true
  const found = new Map<Placeholder['kind'], string>()
  const add = (kind: Placeholder['kind'], line: string, m: RegExpExecArray) => { if (!found.has(kind)) found.set(kind, quoteAround(line, m.index, m[0].length)) }
  for (const line of text.split('\n')) {
    let m: RegExpExecArray | null
    // Filler itself, not a sentence that mentions it: the classic opening, or a block that starts with it.
    if ((m = /\blorem ipsum dolor\b/i.exec(line)) || (m = /^\W*lorem ipsum\b/i.exec(line))) add('lorem_ipsum', line, m)
    // An editor's prompt is a short block of its own; a longer sentence is talking about one.
    if (line.length <= 80 && (m = /\b(click here to edit|click to edit (this )?text|your (text|title|heading|content) (goes )?here|add your (text|title|heading) here|replace this text)\b/i.exec(line))) add('editor_prompt', line, m)
    if ((m = /\[(insert|your|company|placeholder|todo|tbd|name|date)\b[^\]\n]{0,60}\]/i.exec(line))) add('insert_marker', line, m)
    // A template tag that was never rendered: {{ name }}, {{user.name}}, {% if x %}, <%= x %>, ${name}.
    if ((m = /\{\{\s*[#/^>!]?\s*[A-Za-z_$][\w$.\-|: '"()]{0,60}\s*\}\}|\{%\s*[a-z]+\b[^%\n]{0,80}%\}|<%=?\s*[^%\n]{1,80}%>|\$\{[A-Za-z_$][\w$.]{0,60}\}/.exec(line))) add('template_tag', line, m)
    // A value that printed as nothing: the whole line, or beside a label, a currency or a unit.
    if ((lone && (m = /^(undefined|NaN|null)$/.exec(line)))
      || (m = /(?:[$£€]\s?|:\s)(NaN|undefined|\[object Object\])(?=$|[\s.,;%)])/.exec(line))
      || (m = /\b(NaN|undefined)\s?(%|px|items?|results?|reviews?|comments?|days?|hours?|minutes?)(?=$|[\s.,;)])/.exec(line))
      || (m = /\[object Object\]/.exec(line))) add('empty_value', line, m)
  }
  return [...found].map(([kind, quote]) => ({ kind, quote }))
}

export const COPYRIGHT_MAX_LINE = 120

/** The latest year a copyright notice names: "© 2019", "(c) 2015-2021", "Copyright 2020 to 2023". Null without one. */
export function copyrightYear(text: string): { year: number; quote: string } | null {
  let best: { year: number; quote: string } | null = null
  const re = /(?:©|\(c\)|&copy;|\bcopyright\b)(?:\s*(?:©|\(c\)))?[^\n\d]{0,40}?((?:19|20)\d{2})(?:\s*(?:[-–—]|to)\s*((?:19|20)?\d{2,4}))?/gi
  for (const line of text.split('\n')) {
    // A notice is a short line of its own; a longer sentence is writing about copyright.
    if (line.length > COPYRIGHT_MAX_LINE) continue
    for (const m of line.matchAll(re)) {
      const first = Number(m[1])
      let last = first
      if (m[2]) {
        const end = Number(m[2].length === 2 ? `${m[1]!.slice(0, 2)}${m[2]}` : m[2])
        if (end >= first && end < 2200) last = end
      }
      if (!best || last > best.year) best = { year: last, quote: squash(m[0]).slice(0, 80) }
    }
  }
  return best
}

export interface DictionaryTerm { term: string; use?: string }

/** The site's own list (`config.dictionary`), cleaned: at most 200 terms of 2 to 80 characters. */
export function readDictionary(config: Record<string, unknown>): DictionaryTerm[] {
  const raw = Array.isArray(config.dictionary) ? config.dictionary : []
  const out: DictionaryTerm[] = []
  for (const x of raw.slice(0, 200)) {
    const term = typeof x === 'string' ? x : typeof (x as DictionaryTerm | null)?.term === 'string' ? (x as DictionaryTerm).term : ''
    const use = typeof (x as DictionaryTerm | null)?.use === 'string' ? (x as DictionaryTerm).use!.trim().slice(0, 120) : ''
    const t = squash(term)
    if (t.length >= 2 && t.length <= 80 && !out.some((o) => o.term.toLowerCase() === t.toLowerCase())) out.push({ term: t, ...(use ? { use } : {}) })
  }
  return out
}

/** Where each listed term appears as whole words, whatever its case: the first place and how many. */
export function findTerms(text: string, terms: readonly DictionaryTerm[]): { term: string; use?: string; quote: string; count: number }[] {
  const out: { term: string; use?: string; quote: string; count: number }[] = []
  for (const t of terms) {
    const re = new RegExp(`(?<![\\p{L}\\p{N}])${t.term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+')}(?![\\p{L}\\p{N}])`, 'giu')
    let count = 0
    let quote = ''
    for (const line of text.split('\n')) {
      for (const m of line.matchAll(re)) {
        count += 1
        quote ||= quoteAround(line, m.index, m[0].length)
      }
    }
    if (count) out.push({ ...t, quote, count })
  }
  return out
}

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december']
export const DATE_STALE_MONTHS = 18

/**
 * The date a page says it was last updated: "Last updated 3 March 2023",
 * "Updated: March 2023", "Last reviewed on March 3, 2023", "As of 2023-03-03".
 * The newest one on the page, as a UTC month. Null without one.
 */
export function updatedDate(text: string): { year: number; month: number; quote: string } | null {
  const month = `(${MONTHS.join('|')}|sept|${MONTHS.map((m) => m.slice(0, 3)).join('|')})\\.?`
  const lead = '(?:last\\s+(?:updated|modified|reviewed|revised)|updated|page\\s+updated|as\\s+of|reviewed)\\s*(?:on|at|in)?\\s*:?\\s*'
  const forms = [
    new RegExp(`\\b${lead}(?:\\d{1,2}(?:st|nd|rd|th)?\\s+)?${month}\\s+(?:\\d{1,2}(?:st|nd|rd|th)?,?\\s+)?((?:19|20)\\d{2})\\b`, 'gi'),
    new RegExp(`\\b${lead}((?:19|20)\\d{2})-(\\d{2})(?:-\\d{2})?\\b`, 'gi'),
  ]
  let best: { year: number; month: number; quote: string } | null = null
  for (const line of text.split('\n')) {
    if (line.length > 200) continue
    forms.forEach((re, i) => {
      for (const m of line.matchAll(re)) {
        const year = Number(i === 0 ? m[2] : m[1])
        const mon = i === 0 ? MONTHS.findIndex((x) => x.startsWith(m[1]!.toLowerCase().replace('.', '').slice(0, 3))) + 1 : Number(m[2])
        if (mon < 1 || mon > 12) continue
        if (!best || year * 12 + mon > best.year * 12 + best.month) best = { year, month: mon, quote: squash(m[0]).slice(0, 80) }
      }
    })
  }
  return best
}

/** A 64-bit SimHash of a text's three-word runs: alike texts differ in few bits. */
export function simhash(text: string): bigint {
  const words = text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []
  const weights = new Int32Array(64)
  for (let i = 0; i + 2 < words.length; i++) {
    // FNV-1a, 64 bits.
    let h = 0xcbf29ce484222325n
    for (const ch of `${words[i]} ${words[i + 1]} ${words[i + 2]}`) h = BigInt.asUintN(64, (h ^ BigInt(ch.codePointAt(0)!)) * 0x100000001b3n)
    for (let b = 0; b < 64; b++) weights[b]! += (h >> BigInt(b)) & 1n ? 1 : -1
  }
  let out = 0n
  for (let b = 0; b < 64; b++) if (weights[b]! > 0) out |= 1n << BigInt(b)
  return out
}
const bitsApart = (a: bigint, b: bigint) => { let x = a ^ b; let n = 0; while (x) { n += Number(x & 1n); x >>= 1n } return n }

interface Seen {
  /** Per page with enough text to compare: its fingerprint, unless it names another URL as canonical. */
  texts: { url: string; hash: bigint; words: number }[]
  copyright: { year: number; quote: string; url: string; pages: number } | null
}
const seen = new WeakMap<SuiteCtx, Seen>()
const today = (ctx: SuiteCtx) => (typeof ctx.config.today === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(ctx.config.today) ? new Date(`${ctx.config.today}T00:00:00Z`) : new Date())

export const contentSuite: CheckSuite = {
  id: 'content',
  version: '1.0.0',
  requires: ['http'],
  rules: CONTENT_RULES,

  async onPage(ctx, page) {
    if (page.outcome.status !== 200) return
    const { $ } = page.doc
    const state = seen.get(ctx) ?? { texts: [], copyright: null }
    seen.set(ctx, state)
    const text = visibleText($)

    // A page about code (several code samples, or one of these words in its title or headings) names these values on purpose.
    const named = `${page.doc.title ?? ''} ${$('h1, h2, h3').text()}`
    const aboutCode = $('code, pre').length >= 3 || /\b(undefined|NaN|null)\b/.test(named)
    for (const p of findPlaceholders(text, { loneValues: !aboutCode })) {
      await ctx.emit({ rule_id: 'content.placeholder', url: page.url, evidence_key: p.kind, evidence: { kind: p.kind, quote: p.quote } })
    }

    for (const t of findTerms(text, readDictionary(ctx.config))) {
      await ctx.emit({ rule_id: 'content.dictionary', url: page.url, evidence_key: t.term.toLowerCase(), title: `"${t.term}" is on your list of words not to use`, evidence: { term: t.term, ...(t.use ? { use: t.use } : {}), quote: t.quote, count: t.count } })
    }

    // Only pages people reach in one click from the start page: an old blog post is allowed to be old.
    const updated = page.depth <= 1 ? updatedDate(text) : null
    if (updated) {
      const now = today(ctx)
      const months = now.getUTCFullYear() * 12 + now.getUTCMonth() + 1 - (updated.year * 12 + updated.month)
      if (months > DATE_STALE_MONTHS) await ctx.emit({ rule_id: 'content.date_stale', url: page.url, evidence: { quote: updated.quote, months_old: months } })
    }

    // The newest year the site shows anywhere is the one it is judged by.
    const c = copyrightYear(text)
    if (c) {
      if (!state.copyright || c.year > state.copyright.year) state.copyright = { ...c, url: page.url, pages: 1 }
      else if (c.year === state.copyright.year) state.copyright.pages += 1
    }

    const robots = `${$('meta[name="robots" i]').attr('content') ?? ''}`.toLowerCase()
    const main = visibleText($, true)
    const alt = $('main img[alt], body img[alt]').toArray().map((el) => $(el).attr('alt') ?? '').join(' ')
    const words = wordCount(main)
    // A redirect stub (meta refresh) and a page kept out of search on purpose are not unfinished pages.
    // Nor is a page whose job is a form (sign in, search, contact): its fields are its content.
    const isForm = $('form input:not([type="hidden" i]), form textarea, form select').length > 0
    if (words + wordCount(alt) < EMPTY_PAGE_WORDS && !isForm && !$('meta[http-equiv="refresh" i]').length && !robots.includes('noindex')) {
      await ctx.emit({ rule_id: 'content.empty_page', url: page.url, evidence: { words, title: page.doc.title ?? null } })
    }

    // A page that names another URL as its canonical has already said it is a copy.
    let canonicalElsewhere = false
    if (page.doc.canonical) {
      try {
        const c2 = new URL(page.doc.canonical, page.doc.baseUrl)
        const self = new URL(page.outcome.finalUrl || page.url)
        canonicalElsewhere = c2.origin + c2.pathname.replace(/\/$/, '') + c2.search !== self.origin + self.pathname.replace(/\/$/, '') + self.search
      } catch { /* an unreadable canonical is the SEO suite's finding */ }
    }
    if (words >= DUPLICATE_MIN_WORDS && !canonicalElsewhere && !robots.includes('noindex')) state.texts.push({ url: page.url, hash: simhash(main), words })
  },

  async onSite(ctx) {
    const state = seen.get(ctx)
    if (!state) return
    const year = today(ctx).getUTCFullYear()
    if (state.copyright && state.copyright.year < year) {
      await ctx.emit({
        rule_id: 'content.copyright_stale', url: null, evidence_key: String(state.copyright.year),
        title: `Copyright year is ${state.copyright.year}`,
        evidence: { year: state.copyright.year, this_year: year, quote: state.copyright.quote, seen_on: state.copyright.url, pages: state.copyright.pages },
      })
    }

    // Groups of alike pages: each page joins the first group it matches, in URL order, so the result never depends on crawl timing.
    const pages = [...state.texts].sort((a, b) => (a.url < b.url ? -1 : a.url > b.url ? 1 : 0))
    const groups: (typeof pages)[] = []
    for (const p of pages) {
      const g = groups.find((x) => bitsApart(x[0]!.hash, p.hash) <= DUPLICATE_MAX_BITS && Math.min(x[0]!.words, p.words) / Math.max(x[0]!.words, p.words) >= 0.8)
      if (g) g.push(p)
      else groups.push([p])
    }
    for (const g of groups) {
      if (g.length < 2) continue
      const [first, ...rest] = g
      await ctx.emit({
        rule_id: 'content.duplicate', url: first!.url,
        title: `${g.length} pages with the same content`,
        evidence: { pages: g.length, same_as: rest.slice(0, MAX_EVIDENCE_URLS).map((x) => x.url), words: first!.words },
      })
    }
  },
}

export default contentSuite
