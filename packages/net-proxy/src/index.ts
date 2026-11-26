/**
 * Egress proxy for the browser stage (C05.10; pipeline doc §5, SEC-03).
 *
 * Chromium is launched with --proxy-server pointing here and with
 * --host-resolver-rules that stop it resolving names itself, so every
 * request, WebSocket and subresource goes through this proxy. For each
 * CONNECT (HTTPS, WebSockets) and plain-HTTP request the proxy resolves the
 * name, checks every answer against the same ScopePolicy as the crawler
 * (private networks, cloud metadata, deny lists), and connects to the exact
 * address it checked. A DNS answer that changes between requests cannot
 * slip through, and nothing in the browser can reach what the crawler
 * could not.
 */
import { connect, type Socket } from 'node:net'
import { PassThrough, Transform } from 'node:stream'
import { createServer, request as httpRequest, type IncomingMessage, type Server } from 'node:http'
import { isIP } from 'node:net'
import dns from 'node:dns'
import { ScopeDeniedError, ScopePolicy, type LookupFunction, type ScopePolicyConfig } from '@webtrax/net-guard'

export interface ProxyOptions {
  policy?: ScopePolicy | ScopePolicyConfig
  /** Ports the browser may connect to; anything else is refused. Default: any port. */
  allowedPorts?: readonly number[]
  /** Injected DNS for tests. */
  lookup?: LookupFunction
  connectTimeoutMs?: number
  /**
   * Makes the line slower (C06.10: the phone profile's "slow 4G"), the same
   * for every engine behind the proxy. Bytes in each direction share one
   * line, so parallel downloads split it as on a real connection.
   */
  shape?: LineShape
}

export interface LineShape { down_kbps: number; up_kbps: number; latency_ms: number }

/**
 * One direction of a shaped line: every stream made from it shares its
 * rate, and each chunk is also held for `delayMs` (half the round trip).
 */
export function shapedLine(kbps: number, delayMs: number, now: () => number = () => Date.now()) {
  const bytesPerMs = (kbps * 1000) / 8 / 1000
  let freeAt = 0
  return (): Transform => new Transform({
    transform(chunk: Buffer, _enc, done) {
      // The chunk starts when the line is free and takes its size over the rate to pass.
      const start = Math.max(now(), freeAt)
      freeAt = start + chunk.length / bytesPerMs
      const wait = freeAt + delayMs - now()
      setTimeout(() => done(null, chunk), Math.max(0, wait))
    },
  })
}

export interface Refusal { target: string; reason: string }

export interface EgressProxy {
  /** `http://127.0.0.1:<port>`, for --proxy-server. */
  readonly url: string
  readonly port: number
  /** Every refused connection, in order (evidence for the run, and for tests). */
  readonly refused: Refusal[]
  close(): Promise<void>
}

/** Chromium flags that force all traffic through the proxy, loopback included, and disable side channels. */
export function chromiumProxyArgs(proxyUrl: string): string[] {
  return [
    `--proxy-server=${proxyUrl}`,
    // Chrome bypasses proxies for loopback by default; <-loopback> removes that exception.
    '--proxy-bypass-list=<-loopback>',
    // Chromium may not resolve names itself (DNS prefetch, WebRTC); only the proxy address is reachable.
    '--host-resolver-rules=MAP * ~NOTFOUND , EXCLUDE 127.0.0.1',
    '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
    '--disable-quic',
  ]
}

/** The browser engines the browser stage can run (C06.10 slice d). */
export type BrowserEngine = 'chromium' | 'webkit' | 'firefox'

/**
 * Firefox preferences that keep every request on the proxy: loopback too
 * (Firefox never proxies localhost unless told to), no DNS of its own
 * (prefetch, speculative connections, DNS over HTTPS), no WebRTC and no
 * HTTP/3.
 */
export const FIREFOX_PROXY_PREFS: Record<string, string | number | boolean> = {
  'network.proxy.allow_hijacking_localhost': true,
  'network.proxy.no_proxies_on': '',
  'network.dns.disablePrefetch': true,
  'network.dns.disablePrefetchFromHTTPS': true,
  'network.predictor.enabled': false,
  'network.prefetch-next': false,
  'network.http.speculative-parallel-limit': 0,
  'network.trr.mode': 5,
  'network.http.http3.enable': false,
  'media.peerconnection.enabled': false,
}

/**
 * Launch options that put an engine behind the proxy: Chromium by its own
 * flags (`chromiumProxyArgs`), WebKit and Firefox by Playwright's proxy
 * setting with nothing bypassed, and Firefox's preferences above. Every
 * engine is held to the same canary tests (test/proxy.test.ts).
 */
export function browserLaunchOptions(engine: BrowserEngine, proxyUrl: string): { args?: string[]; proxy?: { server: string; bypass: string }; firefoxUserPrefs?: Record<string, string | number | boolean> } {
  if (engine === 'chromium') return { args: chromiumProxyArgs(proxyUrl) }
  const proxy = { server: proxyUrl, bypass: '' }
  return engine === 'firefox' ? { proxy, firefoxUserPrefs: FIREFOX_PROXY_PREFS } : { proxy }
}

function resolveChecked(policy: ScopePolicy, host: string, lookupImpl: LookupFunction): Promise<string> {
  const bare = host.replace(/^\[|\]$/g, '')
  return new Promise((resolve, reject) => {
    if (isIP(bare)) {
      const d = policy.checkAddress(bare, bare)
      return d.allowed ? resolve(bare) : reject(new ScopeDeniedError(d.reason, d.target))
    }
    const url = policy.checkUrl(`http://${bare}/`)
    if (!url.allowed) return reject(new ScopeDeniedError(url.reason, url.target))
    lookupImpl(bare, { all: true }, (err, addresses) => {
      if (err) return reject(err)
      const list = Array.isArray(addresses) ? addresses : [{ address: addresses, family: isIP(addresses) }]
      if (!list.length) return reject(new ScopeDeniedError('no_address', bare))
      for (const a of list) {
        const d = policy.checkAddress(a.address, bare)
        if (!d.allowed) return reject(new ScopeDeniedError(d.reason, d.target))
      }
      resolve(list[0]!.address)
    })
  })
}

export async function startEgressProxy(options: ProxyOptions = {}): Promise<EgressProxy> {
  const policy = options.policy instanceof ScopePolicy ? options.policy : new ScopePolicy(options.policy)
  const lookupImpl = options.lookup ?? (dns.lookup as unknown as LookupFunction)
  const ports = options.allowedPorts ? new Set(options.allowedPorts) : null
  const timeout = options.connectTimeoutMs ?? 10_000
  const refused: Refusal[] = []
  const sockets = new Set<Socket>()
  // Towards the browser (down) and towards the site (up); a plain pass-through when the line is not shaped.
  const down = options.shape ? shapedLine(options.shape.down_kbps, options.shape.latency_ms / 2) : () => new PassThrough()
  const up = options.shape ? shapedLine(options.shape.up_kbps, options.shape.latency_ms / 2) : () => new PassThrough()

  const refuse = (target: string, error: unknown) => {
    const reason = error instanceof ScopeDeniedError ? error.reason : (error as { code?: string }).code ?? 'error'
    refused.push({ target, reason })
    return reason
  }
  const portAllowed = (port: number) => !ports || ports.has(port)

  const server: Server = createServer((req, res) => {
    // Plain-HTTP proxying: req.url is absolute (http://host:port/path).
    let target: URL
    try {
      target = new URL(req.url ?? '')
      if (target.protocol !== 'http:') throw new Error('only http:// is proxied without CONNECT')
    } catch {
      res.writeHead(400).end()
      return
    }
    const port = Number(target.port || 80)
    if (!portAllowed(port)) {
      refuse(target.host, { code: 'port_not_allowed' })
      res.writeHead(403, { 'content-type': 'text/plain' }).end('blocked by webtrax scope policy')
      return
    }
    resolveChecked(policy, target.hostname, lookupImpl).then((address) => {
      const headers = { ...req.headers }
      for (const h of ['proxy-connection', 'proxy-authorization', 'connection', 'keep-alive']) delete headers[h]
      const upstream = httpRequest({ host: address, port, method: req.method, path: target.pathname + target.search, headers, setHost: false, timeout })
      upstream.on('response', (answer: IncomingMessage) => {
        res.writeHead(answer.statusCode ?? 502, answer.headers)
        answer.pipe(down()).pipe(res)
      })
      upstream.on('timeout', () => upstream.destroy(new Error('upstream timeout')))
      upstream.on('error', () => { if (!res.headersSent) res.writeHead(502).end(); else res.destroy() })
      req.pipe(up()).pipe(upstream)
    }, (error: unknown) => {
      refuse(target.host, error)
      res.writeHead(403, { 'content-type': 'text/plain' }).end('blocked by webtrax scope policy')
    })
  })

  // CONNECT tunnels: HTTPS, and WebSockets (Chromium tunnels ws:// too).
  server.on('connect', (req: IncomingMessage, client: Socket, head: Buffer) => {
    sockets.add(client)
    client.on('close', () => sockets.delete(client))
    client.on('error', () => {})
    const m = /^(\[[^\]]+\]|[^:]+):(\d+)$/.exec(req.url ?? '')
    if (!m) { client.end('HTTP/1.1 400 Bad Request\r\n\r\n'); return }
    const host = m[1]!
    const port = Number(m[2])
    if (!portAllowed(port)) {
      refuse(`${host}:${port}`, { code: 'port_not_allowed' })
      client.end('HTTP/1.1 403 Forbidden\r\n\r\n')
      return
    }
    resolveChecked(policy, host, lookupImpl).then((address) => {
      const upstream = connect({ host: address, port, timeout })
      sockets.add(upstream)
      upstream.on('close', () => sockets.delete(upstream))
      upstream.once('connect', () => {
        upstream.setTimeout(0)
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n')
        if (head.length) upstream.write(head)
        upstream.pipe(down()).pipe(client)
        client.pipe(up()).pipe(upstream)
      })
      upstream.on('timeout', () => upstream.destroy())
      upstream.on('error', () => { if (!client.destroyed) client.end('HTTP/1.1 502 Bad Gateway\r\n\r\n') })
    }, (error: unknown) => {
      refuse(`${host}:${port}`, error)
      client.end('HTTP/1.1 403 Forbidden\r\n\r\n')
    })
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as { port: number }).port
  return {
    url: `http://127.0.0.1:${port}`,
    port,
    refused,
    close: () => new Promise((resolve) => {
      for (const s of sockets) s.destroy()
      server.close(() => resolve())
    }),
  }
}
