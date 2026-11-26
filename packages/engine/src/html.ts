/**
 * Parses a page once (cheerio) for everything the engine needs: title, base
 * URL and outgoing links. Suites get the same parsed document (C05.4), so a
 * page is never parsed twice.
 */
import { createHash } from 'node:crypto'
import { load, type CheerioAPI } from 'cheerio'

export interface ExtractedLink { href: string; text: string; rel?: string }
export interface ParsedDoc {
  $: CheerioAPI
  title: string | undefined
  baseUrl: string
  links: ExtractedLink[]
  /** `<link rel="canonical">`, as written (resolve against `baseUrl`). */
  canonical: string | undefined
  /** The layout skeleton's hash (`templateKey`); undefined for a page with no elements in its body. */
  templateKey: string | undefined
}

const SKELETON_DEPTH = 5
const SKELETON_SKIP = new Set(['script', 'style', 'noscript', 'template', 'link', 'meta', 'svg', 'br', 'wbr'])
interface SkeletonNode { type?: string; name?: string; attribs?: Record<string, string>; children?: SkeletonNode[] }

/**
 * A page's layout skeleton as a short hash: the elements in the top levels of
 * the body, each as its tag and class names, with runs of the same element
 * folded into one. Two blog posts of different lengths, or a listing with ten
 * cards and one with forty, give the same key; a product page and the home
 * page do not. Text, ids, attributes and class names that carry a number
 * (`postid-42`, `page-7`) are left out, since those differ on every page of
 * one template.
 */
export function templateKey($: CheerioAPI): string | undefined {
  const sign = (el: SkeletonNode, depth: number): string => {
    const classes = (el.attribs?.class ?? '').split(/\s+/).filter((c) => c && !/\d/.test(c) && c.length <= 40).sort().slice(0, 8).join('.')
    let inner = ''
    if (depth < SKELETON_DEPTH) {
      const parts: string[] = []
      for (const child of el.children ?? []) {
        if (child.type !== 'tag' || !child.name || SKELETON_SKIP.has(child.name)) continue
        const part = sign(child, depth + 1)
        if (parts[parts.length - 1] !== part) parts.push(part)
      }
      inner = parts.join(',')
    }
    return `${el.name}${classes ? `.${classes}` : ''}${inner ? `(${inner})` : ''}`
  }
  const body = $('body').get(0) as SkeletonNode | undefined
  if (!body) return undefined
  const skeleton = sign({ ...body, attribs: {} }, 0)
  if (skeleton === 'body') return undefined
  return createHash('sha256').update(skeleton).digest('hex').slice(0, 16)
}

export function parseHtml(html: string, pageUrl: string): ParsedDoc {
  const $ = load(html)
  const title = $('head > title').first().text().trim() || undefined
  // <base href> changes how relative links resolve (v1 ignored it).
  let baseUrl = pageUrl
  const base = $('base[href]').first().attr('href')
  if (base) {
    try { baseUrl = new URL(base, pageUrl).toString() } catch { /* keep the page URL */ }
  }
  const links: ExtractedLink[] = []
  $('a[href]').each((_, el) => {
    const href = $(el).attr('href')
    if (!href) return
    const rel = $(el).attr('rel')
    links.push({ href, text: $(el).text().replace(/\s+/g, ' ').trim().slice(0, 200), ...(rel ? { rel } : {}) })
  })
  const canonical = $('link[rel~="canonical"][href]').first().attr('href') || undefined
  return { $, title, baseUrl, links, canonical, templateKey: templateKey($) }
}

export const isHtml = (contentType: string | undefined) => !!contentType && /text\/html|application\/xhtml\+xml/i.test(contentType)

const squashSpace = (s: string) => s.replace(/\s+/g, ' ').trim()

/** The text people read, in order, with code samples and anything that is not prose left out. Blocks are separated by a line break. */
export function visibleText($: CheerioAPI, main = false): string {
  const root = main && $('main, [role="main"]').length ? $('main, [role="main"]').first().clone() : $('body').first().clone()
  root.find('script, style, template, noscript, code, pre, kbd, samp, textarea, svg, iframe, select').remove()
  if (main) root.find('nav, header, footer, aside, form, [role="navigation"], [role="banner"], [role="contentinfo"]').remove()
  // cheerio joins blocks with nothing between them: keep them apart.
  root.find('p, div, li, ul, ol, h1, h2, h3, h4, h5, h6, td, th, tr, table, br, hr, section, article, nav, header, footer, main, aside, form, dt, dd, figcaption, blockquote, summary, option').each((_, el) => { $(el).append('\n') })
  // Links and buttons sit inside sentences, and side by side in menus: a space keeps their words apart.
  root.find('a, button, label, span').each((_, el) => { $(el).append(' ') })
  return root.text().split('\n').map(squashSpace).filter(Boolean).join('\n')
}

export const wordCount = (text: string) => (text.match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu) ?? []).length
