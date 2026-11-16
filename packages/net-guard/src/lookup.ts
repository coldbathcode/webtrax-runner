/**
 * A dns.lookup replacement for connections (port of v1 createPublicOnlyLookup,
 * now driven by the scope policy). The address checked is the address the
 * socket connects to, so a hostname cannot pass the check with one answer and
 * connect with another (DNS rebinding). If any answer is refused, the whole
 * lookup fails: a mixed public/private answer is a classic rebinding setup.
 */
import dns from 'node:dns'
import net from 'node:net'
import { ScopeDeniedError, type ScopePolicy } from './policy'

export interface LookupAddress { address: string; family: number }
type Callback = (err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void
export type LookupFunction = (hostname: string, options: dns.LookupOptions, callback: Callback) => void

export function createGuardedLookup(policy: ScopePolicy, lookupImpl: LookupFunction = dns.lookup as unknown as LookupFunction) {
  return function guardedLookup(hostname: string, options: dns.LookupOptions | Callback, callback?: Callback): void {
    const opts: dns.LookupOptions = typeof options === 'function' ? {} : options
    const cb: Callback = typeof options === 'function' ? options : callback!
    const wantAll = Boolean(opts.all)
    lookupImpl(hostname, { ...opts, all: true }, (err, addresses) => {
      if (err) return cb(err, wantAll ? [] : '', 0)
      const list: LookupAddress[] = Array.isArray(addresses) ? addresses : [{ address: addresses, family: net.isIP(addresses) }]
      if (list.length === 0) return cb(new ScopeDeniedError('no_address', hostname), wantAll ? [] : '', 0)
      for (const entry of list) {
        const decision = policy.checkAddress(entry.address, hostname)
        if (!decision.allowed) return cb(new ScopeDeniedError(decision.reason, decision.target), wantAll ? [] : '', 0)
      }
      if (wantAll) return cb(null, list)
      cb(null, list[0]!.address, list[0]!.family)
    })
  }
}
