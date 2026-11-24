/**
 * What a site's links say about it, from one run (C06.9 slice d). Pure and
 * dependency-free at runtime (protocol types only), so the CLI's local MCP
 * reads it from a run on disk and the cloud from a scan's stored map, and both
 * give the same answer:
 *
 * - `impactOfChange` (F-G13): what links to a page, and what a visitor could
 *   no longer reach if it were renamed or removed.
 * - `redirectDebt` (F-A25): internal links that pass through redirects, what
 *   each hop costs, and the address to link to instead.
 * - `brokenLinkReach` (F-E12): broken links ranked by how close they sit to
 *   the pages the team marks as key (pricing, sign-up, checkout) and how many
 *   pages carry them. One on a key page, on the route to one, or a click
 *   from one is escalated.
 */
import type { LinkRecord, PageRecord, RunLine } from '@webtrax/protocol'

export interface GraphPage { url: string; status: number | null; depth: number }
/** One redirect: its status, and how long it took on the wire when measured. */
export interface GraphHop { status: number; ms: number | null }
/** A link target worth a look: broken, or internal and reached through redirects. Sources are page indexes. */
export interface GraphTarget {
  url: string
  internal: boolean
  outcome: LinkRecord['outcome']
  status: number | null
  error?: string
  final_url: string
  hops: GraphHop[]
  from: number[]
  /** Pages that link here, when more than `from` lists. */
  from_total: number
}
export interface LinkGraph {
  origin: string
  start: string
  partial: boolean
  pages: GraphPage[]
  /** Page-to-page links as [from, to] page indexes, one per pair. */
  links: [number, number][]
  /** Pages linked from more than half the pages (navigation). */
  siteWide: Set<number>
  /** Null when the source holds no target list (maps stored before 2026-11-24). */
  targets: GraphTarget[] | null
}

/** Targets kept in a graph, broken ones first, and source pages kept per target. */
export const TARGETS_MAX = 2_000
export const TARGET_SOURCES_MAX = 5_000

type PageInput = Pick<PageRecord, 'url' | 'final_url' | 'status' | 'depth'>
type LinkInput = Pick<LinkRecord, 'url' | 'internal' | 'outcome' | 'status' | 'error' | 'final_url' | 'redirect_chain' | 'from' | 'from_total'>

/** Broken, or internal and through redirects to a working page: what the analyses below look at. */
export const isInterestingTarget = (l: Pick<LinkInput, 'outcome' | 'internal' | 'redirect_chain'>): boolean =>
  l.outcome === 'broken' || (l.internal && l.outcome === 'ok' && l.redirect_chain.length > 0)

/**
 * The graph from a run's page and link records. Pages keep the order of the
 * records; a page is also known by its final URL after a same-site redirect,
 * as in the cloud's map (`graph.json`).
 */
export function buildLinkGraph(pages: PageInput[], links: LinkInput[], meta: { origin: string; start: string; partial: boolean }): LinkGraph {
  const index = new Map(pages.map((p, i) => [p.url, i]))
  pages.forEach((p, i) => { if (!index.has(p.final_url)) index.set(p.final_url, i) })
  const pairs = new Set<string>()
  const out: [number, number][] = []
  const inbound = new Map<number, Set<number>>()
  for (const l of links) {
    const to = index.get(l.url)
    if (to === undefined) continue
    for (const src of l.from) {
      const from = index.get(src)
      if (from === undefined || from === to) continue
      const key = `${from},${to}`
      if (pairs.has(key)) continue
      pairs.add(key)
      out.push([from, to])
      inbound.set(to, (inbound.get(to) ?? new Set()).add(from))
    }
  }
  const half = pages.length / 2
  const siteWide = new Set(pages.length >= 8 ? [...inbound].filter(([, f]) => f.size > half).map(([i]) => i) : [])
  const targets: GraphTarget[] = []
  for (const l of links) {
    if (!isInterestingTarget(l)) continue
    const from = [...new Set(l.from.map((u) => index.get(u)).filter((i): i is number => i !== undefined))]
    if (!from.length) continue
    targets.push({
      url: l.url, internal: l.internal, outcome: l.outcome, status: l.status, ...(l.error ? { error: l.error } : {}), final_url: l.final_url,
      hops: l.redirect_chain.map((h) => ({ status: h.status, ms: h.ms ?? null })),
      from: from.slice(0, TARGET_SOURCES_MAX), from_total: Math.max(l.from_total ?? 0, from.length),
    })
  }
  targets.sort((a, b) => Number(b.outcome === 'broken') - Number(a.outcome === 'broken'))
  return { ...meta, pages: pages.map((p) => ({ url: p.url, status: p.status, depth: p.depth })), links: out, siteWide, targets: targets.slice(0, TARGETS_MAX) }
}

/** The graph of a run on disk (run.ndjson), or null when it crawled no page. */
export function graphFromRun(records: RunLine[]): LinkGraph | null {
  const pages = records.filter((r): r is PageRecord => r.type === 'page')
  if (!pages.length) return null
  const links = records.filter((r): r is LinkRecord => r.type === 'link')
  const summary = records.find((r) => r.type === 'summary')
  const start = pages[0]!.url
  return buildLinkGraph(pages, links, { origin: new URL(start).origin, start, partial: !summary || summary.status !== 'completed' })
}

/** The path of a page of this site (with its query), or the whole URL for anything else. */
export const pathOf = (g: Pick<LinkGraph, 'origin'>, url: string): string => (url.startsWith(`${g.origin}/`) ? url.slice(g.origin.length) : url === g.origin ? '/' : url)

/** The page a path or URL names: exact, then without a trailing slash, then with one. */
export function findPage(g: Pick<LinkGraph, 'origin' | 'pages'>, target: string): number {
  const t = target.trim()
  const url = /^https?:\/\//i.test(t) ? t : g.origin + (t.startsWith('/') ? t : `/${t}`)
  for (const u of [url, url.replace(/\/+$/, ''), `${url.replace(/\/+$/, '')}/`]) {
    const i = g.pages.findIndex((p) => p.url === u)
    if (i >= 0) return i
  }
  return -1
}

const startIndex = (g: LinkGraph): number => Math.max(0, g.pages.findIndex((p) => p.url === g.start))
const adjacency = (g: LinkGraph) => {
  const out: number[][] = Array.from({ length: g.pages.length }, () => [])
  const inn: number[][] = Array.from({ length: g.pages.length }, () => [])
  for (const [a, b] of g.links) { out[a]!.push(b); inn[b]!.push(a) }
  return { out, inn }
}
/** Clicks from `from` to every page along `edges` (-1: no route). */
const distances = (edges: number[][], from: number): Int32Array => {
  const d = new Int32Array(edges.length).fill(-1)
  d[from] = 0
  const queue = [from]
  for (let q = 0; q < queue.length; q++) for (const to of edges[queue[q]!]!) if (d[to] === -1) { d[to] = d[queue[q]!]! + 1; queue.push(to) }
  return d
}

/** How a page is shown when an answer names it. The cloud passes a richer one from its map. */
export type PageView = (i: number) => Record<string, unknown>
export const basicView = (g: LinkGraph): PageView => (i) => ({ path: pathOf(g, g.pages[i]!.url), status: g.pages[i]!.status, clicks_from_start: g.pages[i]!.depth })

const LISTED = 50
const listOf = (g: LinkGraph, ids: number[]) => ({ count: ids.length, pages: ids.slice(0, LISTED).map((i) => pathOf(g, g.pages[i]!.url)), ...(ids.length > LISTED ? { truncated: true } : {}) })

/**
 * What depends on these pages. For each: the pages that link to it, and the
 * pages a visitor could no longer click through to from the start page if it
 * were removed (every route to them runs through it). `together` is the same
 * cut with all of them gone at once, which can be more than the sum.
 */
export function impactOfChange(g: LinkGraph, targets: string[], view: PageView = basicView(g)) {
  const n = g.pages.length
  const start = startIndex(g)
  const { out, inn } = adjacency(g)
  /** Pages reached by links from the start page without passing through `gone`. */
  const reach = (gone: Set<number>): Uint8Array => {
    const seen = new Uint8Array(n)
    if (gone.has(start)) return seen
    const queue = [start]
    seen[start] = 1
    for (let q = 0; q < queue.length; q++) for (const to of out[queue[q]!]!) if (!seen[to] && !gone.has(to)) { seen[to] = 1; queue.push(to) }
    return seen
  }
  const whole = reach(new Set())
  const cutOff = (gone: Set<number>): number[] => {
    const left = reach(gone)
    const lost: number[] = []
    for (let i = 0; i < n; i++) if (whole[i] && !left[i] && !gone.has(i)) lost.push(i)
    return lost
  }

  const found: number[] = []
  const results = targets.map((target) => {
    const i = findPage(g, target)
    if (i < 0) return { target, found: false as const, note: 'The latest scan did not reach a page at this address. It may be new, not linked, blocked by robots.txt, or beyond the scan\'s page limit.' }
    found.push(i)
    const lost = cutOff(new Set([i]))
    const from = [...inn[i]!].sort((a, b) => g.pages[a]!.depth - g.pages[b]!.depth || a - b)
    return {
      target, found: true as const, ...view(i),
      is_start_page: i === start,
      in_site_navigation: g.siteWide.has(i),
      linked_from_pages: listOf(g, from),
      links_to: listOf(g, [...out[i]!].sort((a, b) => a - b)),
      cut_off_if_removed: listOf(g, lost),
      risk: i === start || lost.length >= 10 || g.siteWide.has(i) ? 'high' : lost.length > 0 || from.length >= 10 ? 'medium' : 'low',
    }
  })
  return {
    origin: g.origin, partial: g.partial,
    results,
    ...(found.length > 1 ? { together: { cut_off_if_removed: listOf(g, cutOff(new Set(found))) } } : {}),
    about: 'From the links the latest scan followed. Changing a page\'s address breaks every link in linked_from_pages unless the old address redirects. Pages reached only through a sitemap, a form or script are not counted as cut off.',
  }
}

const NO_TARGETS = 'This scan\'s map was stored before link targets were kept with it (2026-11-24). The next scan will have them.'
const SOURCES_LISTED = 20
const sourcePages = (g: LinkGraph, from: number[]) => [...from].sort((a, b) => g.pages[a]!.depth - g.pages[b]!.depth || a - b).slice(0, SOURCES_LISTED).map((i) => pathOf(g, g.pages[i]!.url))
const clamp = (limit: number | undefined, fallback: number) => Math.min(200, Math.max(1, Math.floor(limit ?? fallback)))

/**
 * Internal links that pass through redirects (F-A25): each address linked to,
 * where it ends, the hops on the way with what each took, the pages that carry
 * the link, and the address to link to instead. Most links times hops first.
 */
export function redirectDebt(g: LinkGraph, input: { limit?: number } = {}) {
  if (!g.targets) return { available: false as const, note: NO_TARGETS }
  const limit = clamp(input.limit, 50)
  const rows = g.targets.filter((t) => t.internal && t.outcome === 'ok' && t.hops.length > 0).map((t) => {
    const timed = t.hops.every((h) => h.ms !== null)
    return {
      address: pathOf(g, t.url),
      redirects_to: pathOf(g, t.final_url),
      hops: t.hops.length,
      statuses: t.hops.map((h) => h.status),
      /** Time spent on the redirects for each visit through this link; null when a hop was not timed. */
      redirect_ms: timed ? t.hops.reduce((s, h) => s + h.ms!, 0) : null,
      permanent: t.hops.every((h) => h.status === 301 || h.status === 308),
      linked_from: t.from_total,
      in_site_navigation: t.from_total > g.pages.length / 2 && g.pages.length >= 8,
      pages: sourcePages(g, t.from),
      fix: `Change links to ${pathOf(g, t.url)} so they point at ${pathOf(g, t.final_url)}.`,
    }
  })
  rows.sort((a, b) => b.linked_from * b.hops - a.linked_from * a.hops || (b.redirect_ms ?? 0) - (a.redirect_ms ?? 0) || a.address.localeCompare(b.address))
  const timed = rows.flatMap((r) => (r.redirect_ms === null ? [] : [r.redirect_ms / r.hops]))
  return {
    available: true as const, origin: g.origin, partial: g.partial,
    totals: {
      addresses: rows.length,
      links: rows.reduce((s, r) => s + r.linked_from, 0),
      pages_carrying: new Set(g.targets.filter((t) => t.internal && t.outcome === 'ok' && t.hops.length > 0).flatMap((t) => t.from)).size,
      median_hop_ms: timed.length ? Math.round([...timed].sort((a, b) => a - b)[Math.floor(timed.length / 2)]!) : null,
    },
    redirects: rows.slice(0, limit),
    has_more: rows.length > limit,
    about: 'Internal links whose address answers with a redirect before the page. Each hop is one more request before the visitor sees anything. Links that end on an error are broken links, not listed here.',
  }
}

/** Paths that are usually worth marking as key pages, offered when none are set. */
export const KEY_PAGE_HINT = /^\/(?:[a-z]{2}(?:-[a-z]{2})?\/)?(pricing|plans|sign-?up|register|join|get-started|start|trial|demo|book-a-demo|contact(?:-us)?|checkout|cart|basket|buy|subscribe|login|log-?in|sign-?in)(?:[/?.]|$)/i

export type KeyRelation = 'on_page' | 'on_route' | 'one_click'

/**
 * Broken links ranked by reach (F-E12). For each broken target: how many
 * pages carry it, the fewest clicks from the start page to one of them, and
 * its relation to each key page: on it, on the shortest route from the start
 * page to it, or one click from it. Any of those escalates it. Ranked
 * escalated first, then nearest a key page, then most pages, then fewest clicks.
 */
export function brokenLinkReach(g: LinkGraph, input: { keyPages?: string[]; limit?: number } = {}) {
  if (!g.targets) return { available: false as const, note: NO_TARGETS }
  const limit = clamp(input.limit, 50)
  const start = startIndex(g)
  const { out, inn } = adjacency(g)
  const fromStart = distances(out, start)
  const keys = [...new Set((input.keyPages ?? []).map((k) => k.trim()).filter(Boolean))].slice(0, 20).map((key) => {
    const i = findPage(g, key)
    return { key, i, toKey: i >= 0 ? distances(inn, i) : null, fromKey: i >= 0 ? distances(out, i) : null }
  })
  const rows = g.targets.filter((t) => t.outcome === 'broken').map((t) => {
    const near: { key_page: string; how: KeyRelation }[] = []
    let nearest = Infinity
    for (const k of keys) {
      if (k.i < 0) continue
      let how: KeyRelation | null = null
      for (const s of t.from) {
        const best: KeyRelation | null = s === k.i ? 'on_page'
          : fromStart[s]! >= 0 && k.toKey![s]! >= 0 && fromStart[k.i]! >= 0 && fromStart[s]! + k.toKey![s]! === fromStart[k.i]! ? 'on_route'
            : k.fromKey![s] === 1 ? 'one_click' : null
        if (best === 'on_page') { how = best; break }
        if (best === 'on_route' || (best === 'one_click' && how === null)) how = best
      }
      for (const s of t.from) if (k.fromKey![s]! >= 0) nearest = Math.min(nearest, k.fromKey![s]!)
      if (how) near.push({ key_page: pathOf(g, g.pages[k.i]!.url), how })
    }
    const depths = t.from.map((s) => g.pages[s]!.depth)
    return {
      target: t.internal ? pathOf(g, t.url) : t.url,
      internal: t.internal,
      status: t.status,
      ...(t.error ? { error: t.error } : {}),
      linked_from: t.from_total,
      clicks_from_start: Math.min(...depths),
      clicks_from_key_page: Number.isFinite(nearest) ? nearest : null,
      key_pages: near,
      escalated: near.length > 0,
      pages: sourcePages(g, t.from),
    }
  })
  const rank = (r: (typeof rows)[number]) => r.clicks_from_key_page ?? Infinity
  rows.sort((a, b) => Number(b.escalated) - Number(a.escalated) || rank(a) - rank(b) || b.linked_from - a.linked_from || a.clicks_from_start - b.clicks_from_start || a.target.localeCompare(b.target))
  return {
    available: true as const, origin: g.origin, partial: g.partial,
    key_pages: keys.map((k) => ({ key_page: k.key, found: k.i >= 0, ...(k.i >= 0 ? { path: pathOf(g, g.pages[k.i]!.url), clicks_from_start: fromStart[k.i]! >= 0 ? fromStart[k.i]! : null } : {}) })),
    ...(keys.length ? {} : { suggested_key_pages: g.pages.map((p, i) => ({ p, i })).filter(({ p }) => p.status !== null && p.status < 400 && KEY_PAGE_HINT.test(pathOf(g, p.url)))
      .sort((a, b) => a.p.depth - b.p.depth || a.i - b.i).slice(0, 5).map(({ p }) => pathOf(g, p.url)) }),
    totals: { broken_targets: rows.length, escalated: rows.filter((r) => r.escalated).length, internal: rows.filter((r) => r.internal).length },
    links: rows.slice(0, limit),
    has_more: rows.length > limit,
    about: 'Broken links the latest scan found, by reach. A link on a key page, on the shortest route from the start page to one, or one click from one is escalated. Links that could not be verified (sign-in walls, bot walls, rate limits) are not broken and not listed.',
  }
}
