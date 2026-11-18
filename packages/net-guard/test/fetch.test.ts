// Real sockets against a local server. Ported cases from
// apps/legacy/tests/runner-guarded-fetch.test.ts, plus redirects into private
// ranges, DNS answers that change between connections, and body caps.
//
// The test server listens on 127.0.0.1. Hostnames are resolved by an injected
// lookup; `site.test` maps to 127.0.0.1, which the tests allow by CIDR, so it
// plays the part of a public site while every other private address stays
// refused.
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { gzipSync } from 'node:zlib'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  createGuardedFetch, readBodyCapped, readTextCapped, ScopeDeniedError, TooManyRedirectsError, type LookupAddress, type LookupFunction,
} from '../src'

let server: http.Server
let port: number
let origin: string

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x')
    // Close every connection, so each request resolves the hostname again.
    res.setHeader('Connection', 'close')
    const go = (status: number, location: string) => {
      res.writeHead(status, { Location: location })
      res.end()
    }
    switch (url.pathname) {
      case '/secret': res.writeHead(200, { 'Content-Type': 'text/plain' }); return res.end('internal secret')
      case '/r1': return go(302, '/r2')
      case '/r2': return go(301, `${origin}/final`)
      case '/final': res.writeHead(200); return res.end('final')
      case '/to-private-literal': return go(302, 'http://10.0.0.5/admin')
      case '/to-private-host': return go(302, `http://internal.test:${port}/secret`)
      case '/to-metadata': return go(307, 'http://169.254.169.254/latest/meta-data/')
      case '/to-ftp': return go(302, 'ftp://example.com/file')
      case '/loop': return go(302, '/loop')
      case '/post303': return go(303, '/method')
      case '/post307': return go(307, '/method')
      case '/method': res.writeHead(200); return res.end(req.method)
      case '/echo-bypass': res.writeHead(200); return res.end(String(req.headers['x-bypass'] ?? ''))
      case '/to-echo': return go(302, '/echo-bypass')
      case '/to-other-echo': return go(302, `http://other.test:${port}/echo-bypass`)
      case '/to-other-back': return go(302, `http://other.test:${port}/to-site-echo`)
      case '/to-site-echo': return go(302, `${origin}/echo-bypass`)
      case '/big': res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end('x'.repeat(3 * 1024 * 1024))
      case '/bomb': res.writeHead(200, { 'Content-Encoding': 'gzip', 'Content-Type': 'text/html' }); return res.end(gzipSync(Buffer.alloc(10 * 1024 * 1024)))
      default: res.writeHead(404); return res.end('nope')
    }
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  port = (server.address() as AddressInfo).port
  origin = `http://site.test:${port}`
})

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())))

/** Fake DNS: a fixed map, or a function per call for rebinding tests. */
function dnsMap(map: Record<string, LookupAddress[] | (() => LookupAddress[])>): LookupFunction {
  return (host, _opts, cb) => {
    const entry = map[host]
    if (!entry) return cb(Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: 'ENOTFOUND' }), [])
    cb(null, typeof entry === 'function' ? entry() : entry)
  }
}
const v4 = (address: string): LookupAddress[] => [{ address, family: 4 }]
const SITE_ALLOWED = { allow: { cidrs: ['127.0.0.1/32'] } }

describe('guarded fetch (ported from v1)', () => {
  const guarded = createGuardedFetch()
  afterAll(() => guarded.close())

  it('refuses private IP literals', async () => {
    await expect(guarded(`http://127.0.0.1:${port}/secret`)).rejects.toThrow(/non-public address/)
  })

  it('refuses hostnames that resolve to private addresses (real DNS)', async () => {
    const err = await guarded(`http://localhost:${port}/secret`).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ScopeDeniedError)
    expect((err as ScopeDeniedError).code).toBe('EBLOCKED')
  })

  it('reaches private targets only when explicitly allowed (local development)', async () => {
    const open = createGuardedFetch({ policy: { allowPrivate: true } })
    const { response } = await open(`http://localhost:${port}/secret`)
    expect(await response.text()).toBe('internal secret')
    await open.close()
  })
})

describe('redirects', () => {
  const guarded = createGuardedFetch({ policy: SITE_ALLOWED, lookup: dnsMap({ 'site.test': v4('127.0.0.1'), 'internal.test': v4('10.0.0.5') }) })
  afterAll(() => guarded.close())

  it('follows a chain and records every hop', async () => {
    const { response, url, chain } = await guarded(`${origin}/r1`)
    expect(await response.text()).toBe('final')
    expect(url).toBe(`${origin}/final`)
    expect(chain).toEqual([{ url: `${origin}/r1`, status: 302 }, { url: `${origin}/r2`, status: 301 }])
  })

  it('refuses a redirect to a private IP literal before connecting', async () => {
    await expect(guarded(`${origin}/to-private-literal`)).rejects.toMatchObject({ reason: 'private_address', target: '10.0.0.5' })
  })

  it('refuses a redirect to a hostname that resolves privately', async () => {
    await expect(guarded(`${origin}/to-private-host`)).rejects.toMatchObject({ reason: 'private_address', target: '10.0.0.5' })
  })

  it('refuses a redirect to cloud metadata, even with private targets allowed', async () => {
    const open = createGuardedFetch({ policy: { allowPrivate: true }, lookup: dnsMap({ 'site.test': v4('127.0.0.1') }) })
    await expect(open(`${origin}/to-metadata`)).rejects.toMatchObject({ reason: 'metadata' })
    await open.close()
  })

  it('refuses a redirect to another scheme', async () => {
    await expect(guarded(`${origin}/to-ftp`)).rejects.toMatchObject({ reason: 'protocol' })
  })

  it('gives up on loops', async () => {
    const short = createGuardedFetch({ policy: SITE_ALLOWED, maxRedirects: 3, lookup: dnsMap({ 'site.test': v4('127.0.0.1') }) })
    const err = await short(`${origin}/loop`).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(TooManyRedirectsError)
    expect((err as TooManyRedirectsError).chain).toHaveLength(4)
    await short.close()
  })

  it('switches POST to GET on 303 and keeps it on 307', async () => {
    expect(await (await guarded(`${origin}/post303`, { method: 'POST', body: 'x' })).response.text()).toBe('GET')
    expect(await (await guarded(`${origin}/post307`, { method: 'POST', body: 'x' })).response.text()).toBe('POST')
  })

  it("returns the redirect itself with redirect: 'manual'", async () => {
    const { response, chain } = await guarded(`${origin}/r1`, { redirect: 'manual' })
    expect(response.status).toBe(302)
    expect(chain).toEqual([])
    await response.body?.cancel()
  })
})

describe('DNS rebinding', () => {
  it('re-checks the answer on every connection: public first, private next time is refused', async () => {
    let calls = 0
    const rebinding = dnsMap({ 'site.test': () => (++calls === 1 ? v4('127.0.0.1') : v4('10.0.0.9')) })
    const guarded = createGuardedFetch({ policy: SITE_ALLOWED, lookup: rebinding })
    const first = await guarded(`${origin}/final`)
    expect(await first.response.text()).toBe('final')
    await expect(guarded(`${origin}/final`)).rejects.toMatchObject({ reason: 'private_address', target: '10.0.0.9' })
    expect(calls).toBe(2)
    await guarded.close()
  })

  it('refuses a mixed answer outright', async () => {
    const guarded = createGuardedFetch({ policy: SITE_ALLOWED, lookup: dnsMap({ 'site.test': [{ address: '127.0.0.1', family: 4 }, { address: '10.0.0.9', family: 4 }] }) })
    await expect(guarded(`${origin}/final`)).rejects.toMatchObject({ reason: 'private_address' })
    await guarded.close()
  })
})

describe('body caps (COR-11)', () => {
  const guarded = createGuardedFetch({ policy: SITE_ALLOWED, lookup: dnsMap({ 'site.test': v4('127.0.0.1') }) })
  afterAll(() => guarded.close())

  it('stops reading at the cap and says so', async () => {
    const { bytes, truncated } = await readBodyCapped((await guarded(`${origin}/big`)).response, 1000)
    expect(truncated).toBe(true)
    expect(bytes.byteLength).toBe(1000)
  })

  it('reads small bodies whole', async () => {
    expect(await readTextCapped((await guarded(`${origin}/final`)).response, 1000)).toEqual({ text: 'final', truncated: false })
  })

  it('counts decompressed bytes, so a gzip bomb is cut off too', async () => {
    const { bytes, truncated } = await readBodyCapped((await guarded(`${origin}/bomb`)).response, 1024 * 1024)
    expect(truncated).toBe(true)
    expect(bytes.byteLength).toBe(1024 * 1024)
  })
})

describe('origin headers', () => {
  const guarded = createGuardedFetch({ policy: SITE_ALLOWED, lookup: dnsMap({ 'site.test': v4('127.0.0.1'), 'other.test': v4('127.0.0.1') }) })
  afterAll(() => guarded.close())
  const bypass = () => ({ originHeaders: { origin, headers: { 'x-bypass': 's3cret' } } })

  it('sends them to their origin, also after a redirect within it', async () => {
    expect(await (await guarded(`${origin}/echo-bypass`, bypass())).response.text()).toBe('s3cret')
    expect(await (await guarded(`${origin}/to-echo`, bypass())).response.text()).toBe('s3cret')
  })

  it('never sends them to another host, even one a redirect leads to', async () => {
    expect(await (await guarded(`${origin}/to-other-echo`, bypass())).response.text()).toBe('')
    expect(await (await guarded(`http://other.test:${port}/echo-bypass`, bypass())).response.text()).toBe('')
    // Back on the origin after a detour: sent again.
    expect(await (await guarded(`${origin}/to-other-back`, bypass())).response.text()).toBe('s3cret')
  })

  it('leaves other requests alone', async () => {
    expect(await (await guarded(`${origin}/echo-bypass`)).response.text()).toBe('')
  })
})
