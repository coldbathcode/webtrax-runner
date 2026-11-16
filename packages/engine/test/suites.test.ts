// The engine side of the suite contract: rule validation, finding fields,
// dedupe, isolation of failing suites, and which suites run.
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { fingerprint, type RuleMeta } from '@webtrax/protocol'
import { crawl, HostThrottle, MemorySink, type CheckSuite } from '../src'

let origin: string
let server: http.Server
beforeAll(async () => {
  server = http.createServer((req, res) => {
    if (req.url === '/') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end('<title>Home</title><a href="/a">a</a>') }
    if (req.url === '/a') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end('<title>A</title>') }
    res.writeHead(404); res.end()
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})
afterAll(() => new Promise<void>((r) => server.close(() => r())))

const meta = (id: string, suite: RuleMeta['suite'] = 'content'): RuleMeta => ({ id, suite, title: `Title of ${id}`, version: 3, severity: 'medium', why: 'w', fix: 'f', docs_slug: 'x', tags: [] })
const run = (suites: CheckSuite[], enabled: Record<string, boolean> = { content: true }) =>
  crawl(
    { spec_version: 1, job_id: 's', target: { start_url: `${origin}/` }, scope: { allow_private: true }, limits: { per_host_rps: 50 },
      suites: Object.fromEntries(Object.entries(enabled).map(([k, v]) => [k, { enabled: v }])) },
    { sink: new MemorySink(), throttle: new HostThrottle(), suites },
  )

describe('suites in the engine', () => {
  it('fills rule fields, fingerprints, dedupes, counts and writes findings', async () => {
    const suite: CheckSuite = {
      id: 'content', version: '9.9.9', requires: ['http'], rules: [meta('content.page.seen')],
      async onPage(ctx, page) {
        await ctx.emit({ rule_id: 'content.page.seen', url: page.url })
        await ctx.emit({ rule_id: 'content.page.seen', url: `${page.url}#again` }) // same finding after normalisation
      },
    }
    const { findings, summary } = await run([suite])
    expect(findings).toHaveLength(2)
    expect(findings[0]).toMatchObject({ suite: 'content', rule_id: 'content.page.seen', rule_version: 3, severity: 'medium', title: 'Title of content.page.seen', url: `${origin}/` })
    expect(findings[0]!.fingerprint).toBe(await fingerprint('content.page.seen', `${origin}/`, ''))
    expect(summary.findings.medium).toBe(2)
    expect(summary.suites).toEqual([{ id: 'content', version: '9.9.9', requires: ['http'] }])
  })

  it('lets a suite override severity per finding', async () => {
    const suite: CheckSuite = { id: 'content', version: '1', requires: ['http'], rules: [meta('content.x')], onSite: (ctx) => ctx.emit({ rule_id: 'content.x', url: null, severity: 'info' }) }
    expect((await run([suite])).findings[0]).toMatchObject({ severity: 'info', url: null })
  })

  it('isolates a failing suite: the crawl completes and the error is reported', async () => {
    const broken: CheckSuite = { id: 'content', version: '1', requires: ['http'], rules: [meta('content.y')], onPage: () => { throw new Error('boom') }, onSite: () => { throw new Error('bang') } }
    const { summary, suiteErrors } = await run([broken])
    expect(summary.status).toBe('completed')
    expect(suiteErrors.map((e) => `${e.hook}:${e.message}`)).toEqual(['onPage:boom', 'onPage:boom', 'onSite:bang'])
  })

  it('treats emitting an undeclared rule as a suite error', async () => {
    const sloppy: CheckSuite = { id: 'content', version: '1', requires: ['http'], rules: [], onSite: (ctx) => ctx.emit({ rule_id: 'content.nope', url: null }) }
    expect((await run([sloppy])).suiteErrors[0]?.message).toMatch(/undeclared rule content\.nope/)
  })

  it('refuses rules that belong to another suite, or are declared twice', async () => {
    await expect(run([{ id: 'content', version: '1', requires: ['http'], rules: [meta('seo.z', 'seo')] }])).rejects.toThrow(/does not belong/)
    await expect(run([{ id: 'content', version: '1', requires: ['http'], rules: [meta('content.d'), meta('content.d')] }])).rejects.toThrow(/declared twice/)
  })

  it('runs only the suites the spec enables', async () => {
    let calls = 0
    const counting: CheckSuite = { id: 'content', version: '1', requires: ['http'], rules: [], onPage: () => { calls += 1 } }
    await run([counting], { content: false })
    await run([counting], { links: true })
    expect(calls).toBe(0)
    await run([counting])
    expect(calls).toBe(2)
  })
})
