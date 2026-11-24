/**
 * Passive lookups for site-level rules (C06.9 slice e, takeover watch): what
 * DNS says about a host, and whether a domain is registered. Nothing here
 * touches the target site, and nothing ever tries to claim anything.
 *
 * Registration is read over RDAP, straight from the registry that runs the
 * domain's top-level domain, found in IANA's bootstrap file. No third-party
 * lookup service sees which domains a site links to. Both are injectable
 * (`CrawlDeps.lookups`) so tests never use the network.
 */
import { Resolver } from 'node:dns/promises'

export interface DnsAnswer {
  /** `nxdomain`: the name does not exist. `error`: the lookup failed for another reason (timeout, refused), which says nothing. */
  status: 'ok' | 'nxdomain' | 'error'
  /** The CNAME chain, first hop first (empty when the name is not an alias). */
  cname: string[]
  addresses: string[]
}
export type Registration = 'registered' | 'available' | 'unknown'
export interface Lookups {
  dns(host: string): Promise<DnsAnswer>
  /** Whether a registrable domain (example.com, example.co.uk) is registered, by its registry's RDAP answer. */
  registration(domain: string): Promise<Registration>
}

/** Second-level labels that are public suffixes under a country code (co.uk, com.au): the registrable domain is one label longer. */
const SECOND_LEVEL = new Set(['co', 'com', 'net', 'org', 'gov', 'edu', 'ac', 'ltd', 'plc', 'me', 'ne', 'or', 'go', 'gob', 'nic', 'mil', 'sch', 'nom', 'biz', 'info', 'gen', 'web', 'firm', 'ind'])

/**
 * The domain someone would register to own this host, by a short rule rather
 * than the full public suffix list: the last two labels, or three under a
 * country code's second level (shop.example.co.uk → example.co.uk). For a
 * hosting platform's subdomains (name.github.io) it answers the platform's
 * own domain, which is registered: such names are the dangling-alias rule's
 * business, not this one's, so the shortcut errs towards saying nothing.
 */
export function registrableDomain(host: string): string | null {
  const labels = host.toLowerCase().replace(/\.$/, '').split('.').filter(Boolean)
  if (labels.length < 2 || labels.some((l) => !/^[a-z0-9-]{1,63}$/.test(l)) || /^\d+$/.test(labels[labels.length - 1]!)) return null
  const tld = labels[labels.length - 1]!
  const take = tld.length === 2 && labels.length >= 3 && SECOND_LEVEL.has(labels[labels.length - 2]!) ? 3 : 2
  return labels.slice(-take).join('.')
}

const DNS_TIMEOUT_MS = 5_000
const codeOf = (e: unknown) => (e as { code?: string }).code ?? ''
const NX = new Set(['ENOTFOUND', 'NXDOMAIN'])

/** DNS through the system's resolvers: the CNAME chain (at most 8 hops), then A and AAAA records. */
export async function systemDns(host: string): Promise<DnsAnswer> {
  const r = new Resolver({ timeout: DNS_TIMEOUT_MS, tries: 2 })
  const cname: string[] = []
  let name = host
  for (let i = 0; i < 8; i++) {
    try {
      const next = (await r.resolveCname(name))[0]
      if (!next || cname.includes(next)) break
      cname.push(next)
      name = next
    } catch (e) {
      // No CNAME here (ENODATA) is the usual answer; a name that does not exist ends the chain the same way.
      if (NX.has(codeOf(e)) && !cname.length) return { status: 'nxdomain', cname, addresses: [] }
      break
    }
  }
  const settled = await Promise.allSettled([r.resolve4(name), r.resolve6(name)])
  const addresses = settled.flatMap((s) => (s.status === 'fulfilled' ? s.value : []))
  if (addresses.length) return { status: 'ok', cname, addresses }
  const errors = settled.flatMap((s) => (s.status === 'rejected' ? [codeOf(s.reason)] : []))
  return { status: errors.length && errors.every((c) => NX.has(c)) ? 'nxdomain' : errors.some((c) => c === 'ENODATA') ? 'ok' : 'error', cname, addresses }
}

export const RDAP_BOOTSTRAP = 'https://data.iana.org/rdap/dns.json'
type Get = (url: string) => Promise<{ status: number | null; body?: string | undefined }>

/** The RDAP base URL for each top-level domain, from IANA's bootstrap file. */
export function parseRdapBootstrap(body: string): Map<string, string> {
  const out = new Map<string, string>()
  try {
    const j = JSON.parse(body) as { services?: [string[], string[]][] }
    for (const [tlds, urls] of j.services ?? []) {
      const base = urls.find((u) => u.startsWith('https://')) ?? urls[0]
      if (base) for (const t of tlds) out.set(t.toLowerCase(), base.endsWith('/') ? base : `${base}/`)
    }
  } catch { /* an unreadable file gives no servers, so every answer is unknown */ }
  return out
}

/**
 * Registration over RDAP with `get` (the run's guarded, throttled fetch).
 * 404 from the registry is "available"; 200 is "registered"; anything else,
 * or a top-level domain without RDAP, is "unknown". The bootstrap file is
 * read once per process and kept a day.
 */
let bootstrap: { at: number; servers: Promise<Map<string, string>> } | null = null
export function rdapRegistration(get: Get, now = () => Date.now()): (domain: string) => Promise<Registration> {
  return async (domain) => {
    if (!bootstrap || now() - bootstrap.at > 86_400_000) {
      const servers = get(RDAP_BOOTSTRAP).then((r) => (r.status === 200 && r.body ? parseRdapBootstrap(r.body) : new Map<string, string>()), () => new Map<string, string>())
      bootstrap = { at: now(), servers }
      // A failed read is not kept: the next run asks again.
      void servers.then((m) => { if (!m.size && bootstrap?.servers === servers) bootstrap = null })
    }
    const base = (await bootstrap.servers).get(domain.split('.').pop() ?? '')
    if (!base) return 'unknown'
    const r = await get(`${base}domain/${encodeURIComponent(domain)}`).catch(() => null)
    return r?.status === 404 ? 'available' : r?.status === 200 ? 'registered' : 'unknown'
  }
}
/** Tests only: forget the bootstrap file. */
export const resetRdapBootstrap = () => { bootstrap = null }
