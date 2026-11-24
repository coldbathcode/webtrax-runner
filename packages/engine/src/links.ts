/**
 * Link targets as a run reports them (C06.9): one `link` record per distinct
 * target the run met, with where a visitor ends up and every page, sitemap and
 * canonical that points at it. The CLI writes them to run.ndjson, so a run on
 * disk holds the site's link graph; the cloud's worker builds the same records
 * for its map and ledger.
 */
import { LINK_SOURCES_MAX, normaliseUrl, type LinkRecord, type RedirectHop } from '@webtrax/protocol'
import { couldNotVerify, isBrokenOutcome } from './classify'
import type { LinkOutcome, SiteState } from './engine'

const isRedirect = (s: number | null) => s !== null && s >= 300 && s < 400

/**
 * Follows a redirect the crawl stopped at a page it already had through that
 * page's own result: the effective outcome, the hops on the way and where
 * they end. Null when the run has no outcome for the target.
 */
export function resolveLink(site: Pick<SiteState, 'links'>, target: string): { outcome: LinkOutcome; hops: number; chain: RedirectHop[]; finalUrl: string } | null {
  let outcome = site.links.get(target)
  if (!outcome) return null
  const chain = [...outcome.chain]
  const seen = new Set([target])
  for (;;) {
    const next = normaliseUrl(outcome.finalUrl)
    if (!isRedirect(outcome.status) || !next || seen.has(next)) break
    const after = site.links.get(next)
    if (!after) break
    seen.add(next)
    chain.push(...after.chain)
    outcome = after
  }
  return { outcome, hops: chain.length, chain, finalUrl: outcome.finalUrl }
}

/** The ledger's judgement of one answer (V2-COR-03): broken, could not verify (sign-in, refusal, bot wall, rate limit, robots), skipped, or ok. */
export function linkOutcome(o: Pick<LinkOutcome, 'via' | 'status' | 'error'>): LinkRecord['outcome'] {
  if (o.via === 'skipped') return 'skipped'
  if (isBrokenOutcome(o)) return 'broken'
  if (couldNotVerify(o) || o.error === 'rate_limited' || o.error === 'robots_disallowed' || o.status === 429) return 'unverified'
  return o.error || o.status === null ? 'unverified' : 'ok'
}

const MAX_URL = 4096

/** One record per link target the run has an outcome for, in the order the run met them. */
export function linkRecords(site: Pick<SiteState, 'links' | 'edges'>): LinkRecord[] {
  const sources = new Map<string, { from: string[]; fromSeen: Set<string>; sitemaps: Set<string>; canonical: Set<string> }>()
  for (const e of site.edges) {
    let s = sources.get(e.to)
    if (!s) { s = { from: [], fromSeen: new Set(), sitemaps: new Set(), canonical: new Set() }; sources.set(e.to, s) }
    if (e.kind === 'link') { if (!s.fromSeen.has(e.from)) { s.fromSeen.add(e.from); s.from.push(e.from) } }
    else if (e.kind === 'sitemap') s.sitemaps.add(e.from)
    else s.canonical.add(e.from)
  }
  const out: LinkRecord[] = []
  for (const [url, raw] of site.links) {
    if (url.length > MAX_URL) continue
    const r = resolveLink(site, url)!
    const s = sources.get(url)
    const finalUrl = r.finalUrl.length <= MAX_URL && /^https?:\/\//i.test(r.finalUrl) ? r.finalUrl : url
    const from = s?.from ?? []
    out.push({
      type: 'link', url, internal: raw.internal, via: raw.via,
      outcome: raw.via === 'skipped' ? 'skipped' : linkOutcome({ via: r.outcome.via, status: r.outcome.status, ...(r.outcome.error ? { error: r.outcome.error } : {}) }),
      status: r.outcome.status, ...(r.outcome.error ? { error: r.outcome.error } : {}),
      final_url: finalUrl, redirect_chain: r.chain.filter((h) => h.url.length <= MAX_URL).slice(0, 20),
      from: from.slice(0, LINK_SOURCES_MAX), ...(from.length > LINK_SOURCES_MAX ? { from_total: from.length } : {}),
      ...(s?.sitemaps.size ? { sitemaps: [...s.sitemaps].slice(0, 100) } : {}),
      ...(s?.canonical.size ? { canonical_from: [...s.canonical].slice(0, LINK_SOURCES_MAX) } : {}),
    })
  }
  return out
}
