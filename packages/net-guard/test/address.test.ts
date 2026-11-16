// Ported from apps/legacy/tests/runner-address.test.ts, plus metadata and CIDR helpers.
import { describe, expect, it } from 'vitest'
import { inCidr, isMetadataAddress, isPublicAddress, isValidCidr } from '../src'

describe('address classification (v1 parity)', () => {
  it('classifies addresses like the v1 guard', () => {
    for (const blocked of ['169.254.169.254', '127.0.0.1', '10.0.0.1', '172.20.0.5', '192.168.0.1', '::1', 'fd00::5', '::ffff:10.0.0.1']) {
      expect(isPublicAddress(blocked), blocked).toBe(false)
    }
    for (const allowed of ['93.184.215.14', '8.8.8.8', '2606:4700::1']) {
      expect(isPublicAddress(allowed), allowed).toBe(true)
    }
  })

  it('treats the rest of the special-purpose ranges as non-public', () => {
    for (const blocked of ['0.0.0.0', '100.64.1.1', '192.0.0.8', '192.0.2.1', '198.18.0.1', '198.51.100.7', '203.0.113.9', '224.0.0.1', '255.255.255.255', '::', 'fe80::1', 'ff02::1', '64:ff9b::a00:1', '2001:db8::1']) {
      expect(isPublicAddress(blocked), blocked).toBe(false)
    }
  })

  it('is not fooled by non-addresses', () => {
    for (const junk of ['', 'localhost', 'example.com', '999.1.1.1', '1.2.3']) expect(isPublicAddress(junk), junk).toBe(false)
  })
})

describe('metadata and CIDRs', () => {
  it('knows the cloud metadata endpoints, including IPv4-mapped forms', () => {
    for (const m of ['169.254.169.254', '::ffff:169.254.169.254', '169.254.170.2', '100.100.100.200', 'fd00:ec2::254']) expect(isMetadataAddress(m), m).toBe(true)
    for (const m of ['169.254.1.1', '10.0.0.1', '8.8.8.8']) expect(isMetadataAddress(m), m).toBe(false)
  })

  it('matches addresses against CIDRs of the same family', () => {
    expect(inCidr('10.20.5.1', '10.20.0.0/16')).toBe(true)
    expect(inCidr('10.21.0.1', '10.20.0.0/16')).toBe(false)
    expect(inCidr('::ffff:10.20.5.1', '10.20.0.0/16')).toBe(true)
    expect(inCidr('fd00::1', 'fd00::/8')).toBe(true)
    expect(inCidr('10.20.5.1', 'fd00::/8')).toBe(false)
    expect(inCidr('10.20.5.1', '10.20.5.1')).toBe(true)
  })

  it('validates CIDRs', () => {
    for (const ok of ['10.0.0.0/8', '10.0.0.1', 'fd00::/8', '0.0.0.0/0']) expect(isValidCidr(ok), ok).toBe(true)
    for (const bad of ['10.0.0.0/33', 'fd00::/129', 'example.com/8', '10.0.0.0/8/1', '', '10.0.0.0/x']) expect(isValidCidr(bad), bad).toBe(false)
  })
})
