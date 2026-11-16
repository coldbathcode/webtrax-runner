// The local MCP server through a real MCP client (in-memory transport):
// tool schemas, each tool against the fixture site, local-only safety, and
// untrusted-content marking.
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startFixtureSite } from '../../../fixtures/site/server.mjs'
import { createMcpServer, isLocalHostname } from '../src/mcp'

let fixture: Awaited<ReturnType<typeof startFixtureSite>>
let client: Client
let root: string

async function connect(allowPublic: boolean, dir: string) {
  const server = createMcpServer({ root: dir, allowPublic, version: 'test' })
  const [a, b] = InMemoryTransport.createLinkedPair()
  const c = new Client({ name: 'test', version: '1' })
  await Promise.all([server.connect(b), c.connect(a)])
  return c
}
type ToolResult = { content: { type: string; text: string }[]; isError?: boolean }
const call = async (c: Client, name: string, args: Record<string, unknown>) => {
  const r = (await c.callTool({ name, arguments: args })) as ToolResult
  return { error: r.isError === true, text: r.content[0]!.text, json: () => JSON.parse(r.content[0]!.text) }
}

beforeAll(async () => {
  fixture = await startFixtureSite()
  root = mkdtempSync(join(tmpdir(), 'webtrax-mcp-'))
  client = await connect(false, root)
})
afterAll(async () => { await client.close(); await fixture.close() })

describe('webtrax mcp', () => {
  it('lists the tools with valid input schemas, plus a prompt and resources', async () => {
    const { tools } = await client.listTools()
    expect(tools.map((t) => t.name).sort()).toEqual(['audit_page', 'check_urls', 'compare_scans', 'explain_finding', 'get_finding', 'get_scan', 'list_findings', 'start_scan', 'wait_for_scan'])
    for (const t of tools) expect(t.inputSchema.type, t.name).toBe('object')
    expect((await client.listPrompts()).prompts.map((p) => p.name)).toEqual(['pre-commit-site-check'])
    expect((await client.listResourceTemplates()).resourceTemplates.map((r) => r.uriTemplate)).toContain('webtrax://local/rules/{rule_id}')
  })

  it('check_urls classifies URLs without crawling', async () => {
    const r = (await call(client, 'check_urls', { urls: [`${fixture.origin}/about`, `${fixture.origin}/missing`, `${fixture.origin}/old-page`] })).json()
    expect(r.results.map((x: { classification: string }) => x.classification)).toEqual(['ok', 'broken', 'redirect'])
    expect(fixture.requests.some((q) => q.path === '/sitemap.xml' || q.path === '/robots.txt')).toBe(false)
  })

  it('audit_page returns the page summary and its findings, marked untrusted', async () => {
    const r = (await call(client, 'audit_page', { url: `${fixture.origin}/` })).json()
    expect(r.untrusted_content).toBe(true)
    expect(r.page.title).toBe('Home')
    expect(r.page.headings[0]).toEqual({ level: 1, text: 'Home' })
    expect(r.findings.map((f: { rule_id: string }) => f.rule_id)).toEqual(expect.arrayContaining(['links.broken.internal', 'links.broken.external', 'seo.lang.missing']))
  })

  it('start_scan, wait_for_scan, list_findings, get_finding, explain_finding and compare_scans work together', async () => {
    const first = (await call(client, 'start_scan', { url: `${fixture.origin}/` })).json()
    expect(first.status).toBe('running')
    const done = (await call(client, 'wait_for_scan', { run_id: first.run_id, timeout_s: 60 })).json()
    expect(done.status).toBe('completed')
    expect(done.summary.findings.high).toBeGreaterThan(0)

    const list = (await call(client, 'list_findings', { severity: 'high' })).json()
    expect(list.run_id).toBe(first.run_id)
    expect(list.findings.every((f: { severity: string }) => f.severity === 'high')).toBe(true)
    const id = list.findings[0].id
    const finding = (await call(client, 'get_finding', { id })).json()
    expect(finding).toMatchObject({ id, fix: expect.any(String), untrusted_content: true })
    expect((await call(client, 'explain_finding', { id })).json().why).toEqual(expect.any(String))

    const paged = (await call(client, 'list_findings', { limit: 2 })).json()
    expect(paged.findings).toHaveLength(2)
    expect((await call(client, 'list_findings', { limit: 2, cursor: paged.next_cursor })).json().findings[0].id).not.toBe(paged.findings[0].id)

    await new Promise((r) => setTimeout(r, 5)) // distinct run directory timestamps
    const second = (await call(client, 'start_scan', { url: `${fixture.origin}/` })).json()
    await call(client, 'wait_for_scan', { run_id: second.run_id, timeout_s: 60 })
    expect((await call(client, 'list_findings', { new_only: true })).json().total).toBe(0)
    const cmp = (await call(client, 'compare_scans', { run_a: first.run_id, run_b: second.run_id })).json()
    expect(cmp.new).toEqual([])
    expect(cmp.persisting).toBe((await call(client, 'list_findings', {})).json().total)

    const report = await client.readResource({ uri: 'webtrax://local/runs/latest/report.md' })
    expect((report.contents[0] as { text: string }).text).toMatch(/^## Webtrax report/)
  })

  it('refuses public targets unless started with --allow-public', async () => {
    const r = await call(client, 'audit_page', { url: 'https://example.com/' })
    expect(r.error).toBe(true)
    expect(r.text).toMatch(/not a local target/)
    expect((await call(client, 'check_urls', { urls: ['https://example.com/'] })).error).toBe(true)
  })

  it('explains rules and serves rule resources', async () => {
    expect((await call(client, 'explain_finding', { id: 'security.header.csp_missing' })).json().fix).toMatch(/Content-Security-Policy/)
    const rule = await client.readResource({ uri: 'webtrax://local/rules/links.broken.internal' })
    expect((rule.contents[0] as { text: string }).text).toContain('# Broken internal link')
  })

  it('knows which hosts are local', () => {
    for (const h of ['localhost', 'app.localhost', 'nas.local', '127.0.0.1', '10.1.2.3', '192.168.1.5', '172.20.0.1', '[::1]', 'fd00::1']) expect(isLocalHostname(h), h).toBe(true)
    for (const h of ['example.com', '8.8.8.8', '172.32.0.1', 'localhost.example.com']) expect(isLocalHostname(h), h).toBe(false)
  })
})
