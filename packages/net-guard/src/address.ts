/**
 * Address classification (port of v1 apps/legacy/runner/lib/address.js).
 *
 * The runner fetches URLs that other people control: a site, every link on
 * it, and every redirect. Without a guard, a "site" of http://169.254.169.254/
 * or a link to an internal hostname would make the crawler fetch from inside
 * whatever network it runs in. So every connection is checked against the
 * IP address it is about to use.
 */
import net from 'node:net'

/** Non-public IPv4 ranges (RFC 6890 special-purpose, private, CGNAT, documentation, multicast, reserved). */
export const NON_PUBLIC_V4: readonly (readonly [string, number])[] = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
]

/** Non-public IPv6 ranges: unspecified, loopback, unique-local, link-local, multicast, NAT64, documentation. */
export const NON_PUBLIC_V6: readonly (readonly [string, number])[] = [
  ['::', 128],
  ['::1', 128],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
  ['64:ff9b::', 96],
  ['2001:db8::', 32],
]

/**
 * Cloud instance-metadata endpoints. Refused in every mode, even when private
 * targets are allowed for local development: they hand out credentials.
 */
export const METADATA_ADDRESSES: readonly string[] = [
  '169.254.169.254', // AWS, GCP, Azure, DigitalOcean, OpenStack …
  '169.254.170.2', // AWS ECS task metadata
  '169.254.169.123', // AWS time sync (same link-local block, listed for clarity)
  '100.100.100.200', // Alibaba Cloud
  'fd00:ec2::254', // AWS IPv6 IMDS
]

const nonPublic = new net.BlockList()
for (const [address, prefix] of NON_PUBLIC_V4) nonPublic.addSubnet(address, prefix, 'ipv4')
for (const [address, prefix] of NON_PUBLIC_V6) nonPublic.addSubnet(address, prefix, 'ipv6')

const metadata = new net.BlockList()
for (const address of METADATA_ADDRESSES) metadata.addAddress(address, net.isIP(address) === 6 ? 'ipv6' : 'ipv4')

/** `::ffff:10.0.0.1` → `10.0.0.1`; anything else unchanged. */
export function unmapIpv4(address: string): string {
  const mapped = address.toLowerCase().match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)
  return mapped ? mapped[1]! : address
}

const family = (address: string): 'ipv4' | 'ipv6' | null => {
  const f = net.isIP(address)
  return f === 4 ? 'ipv4' : f === 6 ? 'ipv6' : null
}

/** True for a routable public address. Anything that is not an IP is not public. */
export function isPublicAddress(address: string): boolean {
  const ip = unmapIpv4(address)
  const f = family(ip)
  return f !== null && !nonPublic.check(ip, f)
}

/** True for a cloud metadata endpoint, which no policy may reach. */
export function isMetadataAddress(address: string): boolean {
  const ip = unmapIpv4(address)
  const f = family(ip)
  return f !== null && metadata.check(ip, f)
}

/** True when `address` is inside `cidr` (e.g. `10.20.0.0/16`, `fd00::/8`). */
export function inCidr(address: string, cidr: string): boolean {
  const [base, bits] = cidr.split('/')
  const ip = unmapIpv4(address)
  const f = family(ip)
  if (!base || f === null || family(base) !== f) return false
  const list = new net.BlockList()
  list.addSubnet(base, Number(bits ?? (f === 'ipv4' ? 32 : 128)), f)
  return list.check(ip, f)
}

/** True for a well-formed CIDR (or a bare address). */
export function isValidCidr(cidr: string): boolean {
  const [base, bits, extra] = cidr.split('/')
  if (!base || extra !== undefined) return false
  const f = family(base)
  if (f === null) return false
  if (bits === undefined) return true
  const n = Number(bits)
  return Number.isInteger(n) && n >= 0 && n <= (f === 'ipv4' ? 32 : 128)
}
