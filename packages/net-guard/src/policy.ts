/**
 * Scope policy (rebuild/06 §Scope policy). Decides, for a URL and for every IP
 * address a connection is about to use, whether the runner may go there.
 *
 * Order of rules, first match wins:
 *   1. cloud metadata addresses: always refused (cannot be overridden);
 *   2. `deny.hosts` / `deny.cidrs`: refused;
 *   3. `allow.cidrs`, or a host in `allow.hosts`: allowed, even if private;
 *   4. a private, loopback or link-local address: allowed only with `allowPrivate`;
 *   5. a public address: allowed when `publicInternet` is true (the default).
 *
 * The default policy is v1's behaviour: public internet only. `allowPrivate`
 * is for local development and `webtrax mcp` against localhost; unlike v1 it
 * no longer switches the guard off, so metadata stays unreachable.
 */
import net from 'node:net'
import { inCidr, isMetadataAddress, isPublicAddress, isValidCidr, unmapIpv4 } from './address'

export interface ScopePolicyConfig {
  allow?: { hosts?: readonly string[]; cidrs?: readonly string[] }
  deny?: { hosts?: readonly string[]; cidrs?: readonly string[] }
  /** May reach public addresses. Default true. */
  publicInternet?: boolean
  /** May reach private, loopback and link-local addresses (local development). Default false. */
  allowPrivate?: boolean
}

export type DenyReason = 'invalid_url' | 'protocol' | 'metadata' | 'denied_host' | 'denied_cidr' | 'private_address' | 'public_not_allowed' | 'no_address'

export type Decision = { allowed: true } | { allowed: false; reason: DenyReason; target: string }

/** Thrown (or passed to callbacks) when the policy refuses a target. `code` matches v1's `EBLOCKED`. */
export class ScopeDeniedError extends Error {
  readonly code = 'EBLOCKED'
  constructor(
    readonly reason: DenyReason,
    readonly target: string,
  ) {
    super(
      reason === 'private_address'
        ? `refusing to connect to non-public address ${target}`
        : reason === 'metadata'
          ? `refusing to connect to cloud metadata address ${target}`
          : `refusing ${target}: ${reason.replace(/_/g, ' ')}`,
    )
    this.name = 'ScopeDeniedError'
  }
}

/** `*.example.com` matches subdomains (not the apex); `example.com` matches exactly. Case-insensitive. */
export function hostMatches(host: string, pattern: string): boolean {
  const h = host.toLowerCase().replace(/\.$/, '')
  const p = pattern.toLowerCase().replace(/\.$/, '')
  if (p.startsWith('*.')) return h.endsWith(p.slice(1)) && h.length > p.length - 1
  return h === p
}

const ALLOW: Decision = { allowed: true }
const deny = (reason: DenyReason, target: string): Decision => ({ allowed: false, reason, target })

export class ScopePolicy {
  readonly allowHosts: readonly string[]
  readonly allowCidrs: readonly string[]
  readonly denyHosts: readonly string[]
  readonly denyCidrs: readonly string[]
  readonly publicInternet: boolean
  readonly allowPrivate: boolean

  constructor(config: ScopePolicyConfig = {}) {
    this.allowHosts = config.allow?.hosts ?? []
    this.allowCidrs = config.allow?.cidrs ?? []
    this.denyHosts = config.deny?.hosts ?? []
    this.denyCidrs = config.deny?.cidrs ?? []
    this.publicInternet = config.publicInternet ?? true
    this.allowPrivate = config.allowPrivate ?? false
    const bad = [...this.allowCidrs, ...this.denyCidrs].filter((c) => !isValidCidr(c))
    if (bad.length) throw new Error(`invalid CIDR in scope policy: ${bad.join(', ')}`)
  }

  /** The URL itself: scheme, denied hosts, and IP literals (which skip DNS). */
  checkUrl(rawUrl: string): Decision {
    let url: URL
    try {
      url = new URL(rawUrl)
    } catch {
      return deny('invalid_url', rawUrl)
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return deny('protocol', url.protocol)
    const host = url.hostname.replace(/^\[|\]$/g, '')
    if (this.denyHosts.some((p) => hostMatches(host, p))) return deny('denied_host', host)
    if (net.isIP(host)) return this.checkAddress(host, host)
    return ALLOW
  }

  /** One resolved address for `hostname`, at connect time. */
  checkAddress(address: string, hostname: string): Decision {
    const ip = unmapIpv4(address)
    if (isMetadataAddress(ip)) return deny('metadata', ip)
    if (this.denyHosts.some((p) => hostMatches(hostname, p))) return deny('denied_host', hostname)
    if (this.denyCidrs.some((c) => inCidr(ip, c))) return deny('denied_cidr', ip)
    if (this.allowCidrs.some((c) => inCidr(ip, c))) return ALLOW
    if (!net.isIP(hostname) && this.allowHosts.some((p) => hostMatches(hostname, p))) return ALLOW
    if (!isPublicAddress(ip)) return this.allowPrivate ? ALLOW : deny('private_address', ip)
    return this.publicInternet ? ALLOW : deny('public_not_allowed', ip)
  }

  /** A short, stable description for reports and `webtrax doctor`. */
  summary(): string {
    const parts = [this.publicInternet ? 'public internet' : 'no public internet', this.allowPrivate ? 'private targets allowed' : 'private targets blocked']
    if (this.allowHosts.length || this.allowCidrs.length) parts.push(`allow ${[...this.allowHosts, ...this.allowCidrs].join(', ')}`)
    if (this.denyHosts.length || this.denyCidrs.length) parts.push(`deny ${[...this.denyHosts, ...this.denyCidrs].join(', ')}`)
    return `${parts.join('; ')}; metadata always blocked`
  }
}

/** Throws the decision's error when it is a refusal. */
export function assertAllowed(decision: Decision): void {
  if (!decision.allowed) throw new ScopeDeniedError(decision.reason, decision.target)
}
