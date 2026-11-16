/**
 * robots.txt (RFC 9309) via robots-parser, as v1 did. The crawl honours
 * Disallow for the WebtraxBot product token, Crawl-delay (capped), and the
 * Sitemap: lines as extra seeds. A missing or unreadable robots.txt allows
 * everything, as the RFC says.
 */
import robotsParser from 'robots-parser'

/**
 * The token robots.txt groups are matched against. robots-parser keeps only
 * what precedes the first "/", so a browser-style UA would match the
 * "mozilla" group and ignore "User-agent: WebtraxBot" rules (v1 COR-27).
 */
export function robotsProductToken(userAgent: string): string {
  const ua = userAgent.trim()
  if (!ua) return '*'
  const compatible = ua.match(/compatible;\s*([A-Za-z0-9_-]+)/i)
  if (compatible) return compatible[1]!
  const leading = ua.match(/^([A-Za-z0-9_-]+)/)
  return leading ? leading[1]! : '*'
}

export interface Robots {
  isAllowed(url: string): boolean
  /** Seconds, if the matching group sets one. */
  crawlDelay(): number | undefined
  sitemaps(): string[]
}

export function parseRobots(robotsUrl: string, text: string, userAgent: string): Robots {
  const robots = robotsParser(robotsUrl, text)
  const token = robotsProductToken(userAgent)
  return {
    isAllowed: (url) => robots.isAllowed(url, token) !== false,
    crawlDelay: () => {
      const d = robots.getCrawlDelay(token)
      return typeof d === 'number' && Number.isFinite(d) && d > 0 ? d : undefined
    },
    sitemaps: () => robots.getSitemaps(),
  }
}

export const ALLOW_ALL: Robots = { isAllowed: () => true, crawlDelay: () => undefined, sitemaps: () => [] }
