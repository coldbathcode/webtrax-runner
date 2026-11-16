/** Sitemaps and sitemap indexes (sitemaps.org). Index recursion is new in v2. */

export interface ParsedSitemap { isIndex: boolean; locs: string[] }

const decodeXmlEntities = (value: string) =>
  value.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&')

/** Same extraction as v1 (`<loc>` values, entity-decoded, de-duplicated), plus index detection. */
export function parseSitemap(xml: string): ParsedSitemap {
  const locs = (xml.match(/<loc>([^<]+)<\/loc>/gi) ?? []).map((m) => decodeXmlEntities(m.replace(/<\/?loc>/gi, '').trim())).filter(Boolean)
  return { isIndex: /<sitemapindex[\s>]/i.test(xml), locs: [...new Set(locs)] }
}
