import { normaliseUrl } from './url'

/**
 * A finding's stable identity across scans, machines and operating systems:
 * sha256(rule_id + "\n" + normalised URL + "\n" + stable evidence key), as hex.
 * The evidence key is defined per rule (the link target for a broken link, the
 * header name for a missing header). Never put timestamps, ordering or timings
 * in it. Web Crypto, so it runs the same in Node, Deno and browsers.
 */
export async function fingerprint(ruleId: string, url: string | null, evidenceKey = ''): Promise<string> {
  const normalised = url === null ? '' : (normaliseUrl(url) ?? url)
  const data = new TextEncoder().encode(`${ruleId}\n${normalised}\n${evidenceKey}`)
  const digest = await crypto.subtle.digest('SHA-256', data)
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}
