/**
 * URL normalisation shared by the frontier, the link cache and fingerprints.
 * Same semantics as v1 (`normalizeUrl` in apps/legacy/runner/lib/crawl-core.js):
 * the fragment is dropped and a trailing slash is removed except on the root.
 * WHATWG URL parsing already lowercases the scheme and host and drops default
 * ports. Returns null for anything that is not an absolute http(s) URL.
 */
export function normaliseUrl(input: string, base?: string): string | null {
  const trimmed = input.trim()
  if (!trimmed || /^(#|mailto:|tel:|javascript:|data:)/i.test(trimmed)) return null
  let url: URL
  try {
    url = base === undefined ? new URL(trimmed) : new URL(trimmed, base)
  } catch {
    return null
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
  url.hash = ''
  if (url.pathname !== '/' && url.pathname.endsWith('/')) url.pathname = url.pathname.slice(0, -1)
  return url.toString()
}
