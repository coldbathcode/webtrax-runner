import { describe, expect, it } from 'vitest'
import { ScopeDeniedError, ScopePolicy, assertAllowed, hostMatches } from '../src'

const reason = (d: ReturnType<ScopePolicy['checkAddress']>) => (d.allowed ? 'allowed' : d.reason)

describe('default policy: public internet only (v1 behaviour)', () => {
  const policy = new ScopePolicy()
  it('allows public addresses and refuses private ones', () => {
    expect(reason(policy.checkAddress('93.184.215.14', 'example.com'))).toBe('allowed')
    expect(reason(policy.checkAddress('10.0.0.1', 'intranet.example.com'))).toBe('private_address')
    expect(reason(policy.checkAddress('::1', 'localhost'))).toBe('private_address')
  })

  it('checks URLs: scheme, IP literals and junk', () => {
    expect(reason(policy.checkUrl('https://example.com/page'))).toBe('allowed')
    expect(reason(policy.checkUrl('http://169.254.169.254/latest/meta-data'))).toBe('metadata')
    expect(reason(policy.checkUrl('http://[::1]:8080/'))).toBe('private_address')
    expect(reason(policy.checkUrl('http://127.0.0.1:3000/'))).toBe('private_address')
    expect(reason(policy.checkUrl('ftp://example.com/'))).toBe('protocol')
    expect(reason(policy.checkUrl('file:///etc/passwd'))).toBe('protocol')
    expect(reason(policy.checkUrl('not a url'))).toBe('invalid_url')
  })
})

describe('allowPrivate (local development, webtrax mcp)', () => {
  const policy = new ScopePolicy({ allowPrivate: true })
  it('reaches localhost and private ranges', () => {
    expect(reason(policy.checkUrl('http://127.0.0.1:3000/'))).toBe('allowed')
    expect(reason(policy.checkAddress('192.168.1.10', 'nas.local'))).toBe('allowed')
  })
  it('still never reaches cloud metadata (v1 switched the guard off entirely)', () => {
    expect(reason(policy.checkUrl('http://169.254.169.254/'))).toBe('metadata')
    expect(reason(policy.checkAddress('fd00:ec2::254', 'imds.example'))).toBe('metadata')
    expect(reason(policy.checkAddress('::ffff:169.254.169.254', 'x'))).toBe('metadata')
  })
})

describe('allow and deny lists (rebuild/06 scope.yml)', () => {
  const policy = new ScopePolicy({
    allow: { hosts: ['*.corp.example.com'], cidrs: ['10.20.0.0/16'] },
    deny: { cidrs: ['10.20.99.0/24'], hosts: ['payroll.corp.example.com'] },
  })
  it('allows listed private ranges and hosts', () => {
    expect(reason(policy.checkAddress('10.20.1.5', 'anything'))).toBe('allowed')
    expect(reason(policy.checkAddress('10.30.1.5', 'wiki.corp.example.com'))).toBe('allowed')
  })
  it('lets deny win over allow, and keeps other private ranges blocked', () => {
    expect(reason(policy.checkAddress('10.20.99.7', 'anything'))).toBe('denied_cidr')
    expect(reason(policy.checkAddress('10.20.1.5', 'payroll.corp.example.com'))).toBe('denied_host')
    expect(reason(policy.checkUrl('https://payroll.corp.example.com/'))).toBe('denied_host')
    expect(reason(policy.checkAddress('192.168.0.1', 'router'))).toBe('private_address')
  })
  it('cannot allow metadata, whatever the lists say', () => {
    const open = new ScopePolicy({ allow: { cidrs: ['169.254.0.0/16'], hosts: ['*.internal'] }, allowPrivate: true })
    expect(reason(open.checkAddress('169.254.169.254', 'metadata.google.internal'))).toBe('metadata')
  })
  it('can turn the public internet off (internal-only runner)', () => {
    const internal = new ScopePolicy({ publicInternet: false, allow: { cidrs: ['10.0.0.0/8'] } })
    expect(reason(internal.checkAddress('8.8.8.8', 'dns.google'))).toBe('public_not_allowed')
    expect(reason(internal.checkAddress('10.1.1.1', 'app.internal'))).toBe('allowed')
  })
  it('rejects malformed CIDRs up front', () => {
    expect(() => new ScopePolicy({ allow: { cidrs: ['10.0.0.0/40'] } })).toThrow(/invalid CIDR/)
  })
  it('describes itself', () => {
    expect(policy.summary()).toContain('metadata always blocked')
    expect(new ScopePolicy().summary()).toBe('public internet; private targets blocked; metadata always blocked')
  })
})

describe('helpers', () => {
  it('matches host patterns', () => {
    expect(hostMatches('wiki.corp.example.com', '*.corp.example.com')).toBe(true)
    expect(hostMatches('corp.example.com', '*.corp.example.com')).toBe(false)
    expect(hostMatches('evilcorp.example.com', '*.corp.example.com')).toBe(false)
    expect(hostMatches('Example.COM.', 'example.com')).toBe(true)
  })
  it('throws a coded error for refusals', () => {
    expect(() => assertAllowed(new ScopePolicy().checkUrl('http://10.0.0.1/'))).toThrow(ScopeDeniedError)
    try {
      assertAllowed(new ScopePolicy().checkUrl('http://10.0.0.1/'))
    } catch (e) {
      expect((e as ScopeDeniedError).code).toBe('EBLOCKED')
      expect((e as Error).message).toMatch(/non-public address 10\.0\.0\.1/)
    }
  })
})
