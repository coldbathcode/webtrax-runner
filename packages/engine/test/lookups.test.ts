// Passive lookups (C06.9 slice e): RDAP from the registry IANA names, never a
// third-party service; 404 means available, 200 registered, anything else unknown.
import { afterEach, describe, expect, it } from 'vitest'
import { parseRdapBootstrap, RDAP_BOOTSTRAP, rdapRegistration, resetRdapBootstrap } from '../src/lookups'

const BOOT = JSON.stringify({ services: [[['com', 'net'], ['https://rdap.verisign.com/com/v1/']], [['io'], ['http://rdap.nic.io', 'https://rdap.nic.io']]] })

afterEach(() => resetRdapBootstrap())

describe('RDAP registration', () => {
  it('reads the bootstrap file, preferring https and ending each base with a slash', () => {
    expect([...parseRdapBootstrap(BOOT)]).toEqual([['com', 'https://rdap.verisign.com/com/v1/'], ['net', 'https://rdap.verisign.com/com/v1/'], ['io', 'https://rdap.nic.io/']])
    expect(parseRdapBootstrap('not json').size).toBe(0)
  })

  it('asks the domain\'s own registry, once for the bootstrap, and reads its status', async () => {
    const asked: string[] = []
    const answers: Record<string, number> = { 'https://rdap.verisign.com/com/v1/domain/gone.com': 404, 'https://rdap.verisign.com/com/v1/domain/there.com': 200, 'https://rdap.nic.io/domain/odd.io': 500 }
    const reg = rdapRegistration(async (url) => { asked.push(url); return url === RDAP_BOOTSTRAP ? { status: 200, body: BOOT } : { status: answers[url] ?? 404 } })
    expect(await reg('gone.com')).toBe('available')
    expect(await reg('there.com')).toBe('registered')
    expect(await reg('odd.io')).toBe('unknown')
    expect(await reg('example.zz')).toBe('unknown')
    expect(asked.filter((u) => u === RDAP_BOOTSTRAP)).toHaveLength(1)
    expect(asked.every((u) => u === RDAP_BOOTSTRAP || u.startsWith('https://rdap.verisign.com/') || u.startsWith('https://rdap.nic.io/'))).toBe(true)
  })

  it('a bootstrap file it cannot read gives unknown, and is asked for again next time', async () => {
    let boot = 0
    const reg = rdapRegistration(async (url) => { if (url === RDAP_BOOTSTRAP) { boot++; return { status: 503 } } return { status: 404 } })
    expect(await reg('gone.com')).toBe('unknown')
    await new Promise((r) => setTimeout(r, 0))
    expect(await reg('gone.com')).toBe('unknown')
    expect(boot).toBe(2)
  })
})
