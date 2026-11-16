// The egress proxy with raw CONNECT and HTTP requests, and with a real
// Chromium launched the way the browser stage launches it. A local server
// plays the site; `site.test` resolves to it (allowed by CIDR) while every
// other private address stays refused.
import http from 'node:http'
import { connect } from 'node:net'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { chromium } from 'playwright-core'
import type { LookupAddress, LookupFunction } from '@webtrax/net-guard'
import { chromiumProxyArgs, startEgressProxy } from '../src'

let site: http.Server
let port: number
const hits: string[] = []

beforeAll(async () => {
  site = http.createServer((req, res) => {
    hits.push(req.url ?? '')
    if (req.url === '/') {
      res.writeHead(200, { 'content-type': 'text/html' })
      // The page tries to reach a private address and cloud metadata from the browser.
      return res.end(`<!doctype html><title>Site</title><h1>Hello</h1>
<img src="http://10.0.0.5/private.png" alt="">
<img src="http://169.254.169.254/latest/meta-data/iam" alt="">
<img src="/ok.png" alt="">`)
    }
    if (req.url === '/ok.png') { res.writeHead(200, { 'content-type': 'image/png' }); return res.end() }
    res.writeHead(404).end()
  })
  await new Promise<void>((r) => site.listen(0, '127.0.0.1', r))
  port = (site.address() as AddressInfo).port
})
afterAll(() => new Promise<void>((r) => site.close(() => r())))

const dnsMap = (map: Record<string, LookupAddress[] | (() => LookupAddress[])>): LookupFunction => (host, _o, cb) => {
  const e = map[host]
  if (!e) return cb(Object.assign(new Error(`ENOTFOUND ${host}`), { code: 'ENOTFOUND' }), [])
  cb(null, typeof e === 'function' ? e() : e)
}
const v4 = (address: string): LookupAddress[] => [{ address, family: 4 }]
const POLICY = { allow: { cidrs: ['127.0.0.1/32'] } }

/** Sends a CONNECT and returns the proxy's status line; on 200, also a GET through the tunnel. */
function tunnel(proxyPort: number, target: string): Promise<{ status: number; body?: string }> {
  return new Promise((resolve, reject) => {
    const sock = connect(proxyPort, '127.0.0.1', () => sock.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`))
    let buf = ''
    let tunnelled = false
    sock.on('data', (d) => {
      buf += d.toString()
      if (!tunnelled && buf.includes('\r\n\r\n')) {
        const status = Number(/^HTTP\/1\.1 (\d{3})/.exec(buf)?.[1])
        if (status !== 200) { sock.destroy(); return resolve({ status }) }
        tunnelled = true
        buf = ''
        sock.write(`GET /ok.png HTTP/1.1\r\nHost: ${target}\r\nConnection: close\r\n\r\n`)
      }
    })
    sock.on('end', () => resolve({ status: 200, body: buf }))
    sock.on('error', reject)
  })
}

function viaProxy(proxyPort: number, url: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: proxyPort, method: 'GET', path: url, headers: { host: new URL(url).host } }, (res) => { res.resume(); resolve(res.statusCode ?? 0) })
    req.on('error', reject)
    req.end()
  })
}

describe('egress proxy: CONNECT', () => {
  it('tunnels to an allowed host, connecting to the address it checked', async () => {
    const proxy = await startEgressProxy({ policy: POLICY, lookup: dnsMap({ 'site.test': v4('127.0.0.1') }) })
    const r = await tunnel(proxy.port, `site.test:${port}`)
    expect(r.status).toBe(200)
    expect(r.body).toMatch(/^HTTP\/1\.1 200/)
    await proxy.close()
  })

  it('refuses private addresses, metadata and literal IPs outside the policy', async () => {
    const proxy = await startEgressProxy({ policy: { ...POLICY, allowPrivate: false }, lookup: dnsMap({ 'internal.test': v4('10.1.1.1') }) })
    expect((await tunnel(proxy.port, 'internal.test:443')).status).toBe(403)
    expect((await tunnel(proxy.port, '169.254.169.254:80')).status).toBe(403)
    expect((await tunnel(proxy.port, '[::1]:443')).status).toBe(403)
    expect(proxy.refused.map((r) => r.reason)).toEqual(['private_address', 'metadata', 'private_address'])
    await proxy.close()
  })

  it('refuses metadata even when private targets are allowed', async () => {
    const proxy = await startEgressProxy({ policy: { allowPrivate: true } })
    expect((await tunnel(proxy.port, '169.254.169.254:80')).status).toBe(403)
    await proxy.close()
  })

  it('re-checks DNS on every connection (rebinding) and refuses mixed answers', async () => {
    let n = 0
    const proxy = await startEgressProxy({ policy: POLICY, lookup: dnsMap({ 'site.test': () => (++n === 1 ? v4('127.0.0.1') : v4('10.9.9.9')), 'mixed.test': [{ address: '127.0.0.1', family: 4 }, { address: '10.0.0.1', family: 4 }] }) })
    expect((await tunnel(proxy.port, `site.test:${port}`)).status).toBe(200)
    expect((await tunnel(proxy.port, `site.test:${port}`)).status).toBe(403)
    expect((await tunnel(proxy.port, `mixed.test:${port}`)).status).toBe(403)
    await proxy.close()
  })

  it('refuses ports outside allowedPorts', async () => {
    const proxy = await startEgressProxy({ policy: POLICY, allowedPorts: [443], lookup: dnsMap({ 'site.test': v4('127.0.0.1') }) })
    expect((await tunnel(proxy.port, `site.test:${port}`)).status).toBe(403)
    expect(proxy.refused[0]).toMatchObject({ reason: 'port_not_allowed' })
    await proxy.close()
  })
})

describe('egress proxy: plain HTTP', () => {
  it('forwards allowed requests and refuses the rest', async () => {
    const proxy = await startEgressProxy({ policy: POLICY, lookup: dnsMap({ 'site.test': v4('127.0.0.1'), 'internal.test': v4('192.168.1.1') }) })
    expect(await viaProxy(proxy.port, `http://site.test:${port}/ok.png`)).toBe(200)
    expect(await viaProxy(proxy.port, 'http://internal.test/')).toBe(403)
    expect(await viaProxy(proxy.port, 'http://169.254.169.254/latest/meta-data/')).toBe(403)
    await proxy.close()
  })
})

describe('Chromium through the proxy', () => {
  it('loads the page while the page cannot reach private networks or metadata', async () => {
    const proxy = await startEgressProxy({ policy: POLICY, lookup: dnsMap({ 'site.test': v4('127.0.0.1') }) })
    const browser = await chromium.launch({ args: chromiumProxyArgs(proxy.url) })
    try {
      const context = await browser.newContext({ serviceWorkers: 'block' })
      const page = await context.newPage()
      const response = await page.goto(`http://site.test:${port}/`, { waitUntil: 'load' })
      expect(response?.status()).toBe(200)
      expect(await page.locator('h1').textContent()).toBe('Hello')
      const targets = proxy.refused.map((r) => r.target)
      expect(targets).toEqual(expect.arrayContaining(['10.0.0.5', '169.254.169.254']))
      expect(hits).toContain('/ok.png')
      // Chromium never resolved names itself: a direct navigation to a real name fails without the proxy's help.
      await context.close()
    } finally {
      await browser.close()
      await proxy.close()
    }
  }, 60_000)

  it('does not let localhost bypass the proxy', async () => {
    const proxy = await startEgressProxy({ policy: { allowPrivate: false } })
    const browser = await chromium.launch({ args: chromiumProxyArgs(proxy.url) })
    try {
      const page = await browser.newPage()
      const response = await page.goto(`http://127.0.0.1:${port}/`).catch(() => null)
      expect(response?.status() ?? 403).toBe(403)
      expect(proxy.refused.some((r) => r.target.startsWith('127.0.0.1'))).toBe(true)
    } finally {
      await browser.close()
      await proxy.close()
    }
  }, 60_000)
})
