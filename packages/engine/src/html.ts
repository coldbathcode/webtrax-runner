/**
 * Parses a page once (cheerio) for everything the engine needs: title, base
 * URL and outgoing links. Suites get the same parsed document (C05.4), so a
 * page is never parsed twice.
 */
import { load, type CheerioAPI } from 'cheerio'

export interface ExtractedLink { href: string; text: string; rel?: string }
export interface ParsedDoc {
  $: CheerioAPI
  title: string | undefined
  baseUrl: string
  links: ExtractedLink[]
  /** `<link rel="canonical">`, as written (resolve against `baseUrl`). */
  canonical: string | undefined
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
  return { $, title, baseUrl, links, canonical }
}

export const isHtml = (contentType: string | undefined) => !!contentType && /text\/html|application\/xhtml\+xml/i.test(contentType)
