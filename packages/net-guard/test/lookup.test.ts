// Ported from apps/legacy/tests/runner-address.test.ts (lookup cases), now policy-driven.
import { describe, expect, it } from 'vitest'
import { createGuardedLookup, ScopePolicy, type LookupAddress, type LookupFunction } from '../src'

const returning = (addresses: LookupAddress[]): LookupFunction => (_host, _opts, cb) => cb(null, addresses)
const run = (lookup: ReturnType<typeof createGuardedLookup>, opts: object) =>
  new Promise<{ err: Error | null; a: unknown; f: unknown }>((resolve) => lookup('host.example', opts, (err, a, f) => resolve({ err, a, f })))

describe('guarded lookup', () => {
  it('fails when any answer is private, in both callback shapes', async () => {
    const lookup = createGuardedLookup(new ScopePolicy(), returning([{ address: '93.184.215.14', family: 4 }, { address: '10.1.2.3', family: 4 }]))
    expect((await run(lookup, { all: true })).err?.message).toMatch(/non-public address 10\.1\.2\.3/)
    const single = await run(lookup, {})
    expect(single.err?.message).toMatch(/non-public address 10\.1\.2\.3/)
    expect(single.a).toBe('')
  })

  it('returns public answers in the shape Node asked for', async () => {
    const lookup = createGuardedLookup(new ScopePolicy(), returning([{ address: '93.184.215.14', family: 4 }]))
    expect((await run(lookup, { all: true })).a).toEqual([{ address: '93.184.215.14', family: 4 }])
    const single = await run(lookup, {})
    expect([single.a, single.f]).toEqual(['93.184.215.14', 4])
  })

  it('refuses an empty answer and passes resolver errors through', async () => {
    expect((await run(createGuardedLookup(new ScopePolicy(), returning([])), {})).err).toMatchObject({ reason: 'no_address' })
    const failing: LookupFunction = (_h, _o, cb) => cb(Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' }), [])
    expect((await run(createGuardedLookup(new ScopePolicy(), failing), {})).err).toMatchObject({ code: 'ENOTFOUND' })
  })

  it('applies the policy with the hostname (allow.hosts)', async () => {
    const lookup = createGuardedLookup(new ScopePolicy({ allow: { hosts: ['host.example'] } }), returning([{ address: '10.1.2.3', family: 4 }]))
    expect((await run(lookup, {})).err).toBeNull()
  })
})
