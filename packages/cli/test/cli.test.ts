import { execFile, execFileSync } from 'node:child_process'
import { promisify } from 'node:util'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startFixtureSite } from '../../../fixtures/site/server.mjs'
import { EXIT, failureReason, main, VERSION, type Io } from '../src/main'
import { buildSpec, loadConfig } from '../src/config'

let fixture: Awaited<ReturnType<typeof startFixtureSite>>
let cwd: string
beforeAll(async () => { fixture = await startFixtureSite() })
afterAll(async () => { await fixture.close() })

function io(dir = cwd) {
  const out: string[] = []
  const err: string[] = []
  const value: Io = { stdout: (t) => out.push(t), stderr: (t) => err.push(t), cwd: dir }
  return { io: value, out: () => out.join(''), err: () => err.join('') }
}
const fresh = () => (cwd = mkdtempSync(join(tmpdir(), 'webtrax-cli-')))
const runs = (dir = cwd) => readdirSync(join(dir, '.webtrax', 'runs')).sort()
const FAST = ['--rps', '50']

describe('webtrax check', () => {
  it('crawls the fixture, writes the run and reports, and exits 1 on high findings', async () => {
    fresh()
    const t = io()
    const code = await main(['check', `${fixture.origin}/`, ...FAST], t.io)
    expect(code).toBe(EXIT.findings)
    expect(t.out()).toContain('Broken internal link')
    expect(t.out()).toMatch(/Report: \.webtrax\/runs\/.+\/report\.html/)
    const [run] = runs()
    for (const f of ['run.ndjson', 'report.html', 'report.md']) expect(existsSync(join(cwd, '.webtrax', 'runs', run!, f)), f).toBe(true)
  })

  it('allows localhost and private IPs without --allow-private', async () => {
    fresh()
    expect(await main(['check', `${fixture.origin}/`, ...FAST, '--fail-on', 'none'], io().io)).toBe(EXIT.ok)
  })

  it('honours --fail-on, --suites and --max-pages', async () => {
    fresh()
    expect(await main(['check', `${fixture.origin}/`, ...FAST, '--fail-on', 'critical'], io().io)).toBe(EXIT.ok)
    const t = io()
    expect(await main(['check', `${fixture.origin}/`, ...FAST, '--suites', 'seo', '--max-pages', '2', '--stdout', 'json', '--fail-on', 'none'], t.io)).toBe(EXIT.ok)
    const json = JSON.parse(t.out())
    expect(json.summary.suites.map((s: { id: string }) => s.id)).toEqual(['seo'])
    expect(json.summary.pages.crawled).toBeLessThanOrEqual(2)
  })

  it('prints Markdown for agents with --stdout md, and nothing with --quiet', async () => {
    fresh()
    const md = io()
    await main(['check', `${fixture.origin}/`, ...FAST, '--stdout', 'md'], md.io)
    expect(md.out()).toMatch(/^## Webtrax report: /)
    const quiet = io()
    expect(await main(['check', `${fixture.origin}/`, ...FAST, '--quiet'], quiet.io)).toBe(EXIT.findings)
    expect(quiet.out() + quiet.err()).toBe('')
  })

  it('leaves --ignore rules out of the report and the exit code, and rejects unknown rules', async () => {
    fresh()
    const t = io()
    const code = await main(['check', `${fixture.origin}/`, ...FAST, '--suites', 'links', '--ignore', 'links.broken.internal,links.broken.external', '--stdout', 'json'], t.io)
    expect(code).toBe(EXIT.ok)
    expect(JSON.parse(t.out()).findings.some((f: { rule_id: string }) => f.rule_id.startsWith('links.broken'))).toBe(false)
    expect(await main(['check', `${fixture.origin}/`, '--ignore', 'links.nope'], io().io)).toBe(EXIT.usage)
  })

  it('runs the browser suites with --browser (Chromium through the egress proxy)', async () => {
    fresh()
    const t = io()
    await main(['check', `${fixture.origin}/`, ...FAST, '--browser', '--max-pages', '3', '--stdout', 'json', '--fail-on', 'none'], t.io)
    const json = JSON.parse(t.out())
    expect(json.summary.suites.map((s: { id: string }) => s.id)).toEqual(['links', 'security', 'seo', 'content', 'ai_readiness', 'a11y', 'performance'])
    expect(json.findings.some((f: { rule_id: string }) => f.rule_id === 'a11y.html_has_lang')).toBe(true)
  }, 90_000)

  it('writes runs under --out', async () => {
    fresh()
    await main(['check', `${fixture.origin}/`, ...FAST, '--out', 'reports', '--quiet', '--reports', 'json,sarif,junit'], io().io)
    const [run] = readdirSync(join(cwd, 'reports', 'runs'))
    for (const f of ['report.json', 'report.sarif', 'report.junit.xml']) expect(existsSync(join(cwd, 'reports', 'runs', run!, f)), f).toBe(true)
    expect(JSON.parse(readFileSync(join(cwd, 'reports', 'runs', run!, 'report.sarif'), 'utf8')).version).toBe('2.1.0')
  })

  it('exits 3 when the site cannot be crawled', async () => {
    fresh()
    const t = io()
    expect(await main(['check', 'http://127.0.0.1:1/', '--quiet'], t.io)).toBe(EXIT.unreachable)
  })

  it('says why: the start page status, or the fetch error', () => {
    expect(failureReason({ error: 'start_url_unreachable', start: { status: 503 } })).toBe('start url unreachable: HTTP 503')
    expect(failureReason({ error: 'start_url_unreachable', start: { status: 403 } })).toMatch(/HTTP 403, a firewall or login may be blocking WebtraxBot/)
    expect(failureReason({ error: 'start_url_unreachable', start: { status: null, error: 'connection_error' } })).toBe('start url unreachable: connection error')
    expect(failureReason({ error: 'start_url_redirects_offsite' })).toBe('start url redirects offsite')
  })

  it('exits 2 on usage and config errors', async () => {
    fresh()
    for (const args of [['check'], ['check', 'ftp://x.example'], ['check', 'https://x.example', '--fail-on', 'urgent'], ['check', 'https://x.example', '--suites', 'spelling'], ['check', '--bogus'], ['nope']]) {
      const t = io()
      expect(await main(args, t.io), args.join(' ')).toBe(EXIT.usage)
      expect(t.err()).toMatch(/webtrax: /)
    }
    writeFileSync(join(cwd, 'webtrax.yml'), 'version: 1\nlimits: { max_pages: -1 }\n')
    expect(await main(['check', 'https://x.example'], io().io)).toBe(EXIT.usage)
  })
})

describe('--header', () => {
  it('sends the header but never writes its value to the run or a report', async () => {
    fresh()
    const t = io()
    const code = await main(['check', `${fixture.origin}/`, ...FAST, '--max-pages', '3', '--fail-on', 'none', '--reports', 'html,md,json,sarif,junit', '--stdout', 'json', '--header', 'x-vercel-protection-bypass:s3cret-value'], t.io)
    expect(code).toBe(EXIT.ok)
    const [run] = runs()
    const dir = join(cwd, '.webtrax', 'runs', run!)
    for (const f of readdirSync(dir)) expect(readFileSync(join(dir, f), 'utf8'), f).not.toContain('s3cret-value')
    expect(t.out()).not.toContain('s3cret-value')
    expect(readFileSync(join(dir, 'run.ndjson'), 'utf8')).toContain('"x-vercel-protection-bypass":"[redacted]"')
  })

  it('refuses a malformed header without echoing its value', async () => {
    fresh()
    for (const bad of ['no-colon-s3cret-value', 'bad name:s3cret-value', 'x-empty:']) {
      const t = io()
      expect(await main(['check', `${fixture.origin}/`, '--header', bad], t.io)).toBe(EXIT.usage)
      expect(t.err()).toMatch(/--header/)
      expect(t.err()).not.toContain('s3cret-value')
    }
  })
})

describe('webtrax.yml', () => {
  it('init writes a config that check then uses, and will not overwrite it', async () => {
    fresh()
    expect(await main(['init', `${fixture.origin}/`], io().io)).toBe(EXIT.ok)
    expect(readFileSync(join(cwd, 'webtrax.yml'), 'utf8')).toContain(`target: ${fixture.origin}/`)
    expect(await main(['init', 'https://other.example'], io().io)).toBe(EXIT.usage)
    writeFileSync(join(cwd, 'webtrax.yml'), readFileSync(join(cwd, 'webtrax.yml'), 'utf8').replace('per_host_rps: 2', 'per_host_rps: 50').replace('fail_on: high', 'fail_on: none'))
    expect(await main(['check', '--quiet'], io().io)).toBe(EXIT.ok)
  })
})

describe('--profile', () => {
  it('measures pages as a desktop and as a phone, and reports both; an unknown profile is a usage error', async () => {
    fresh()
    const t = io()
    expect(await main(['check', `${fixture.origin}/`, ...FAST, '--max-pages', '3', '--suites', 'links', '--profile', 'desktop,phone', '--fail-on', 'none', '--stdout', 'json'], t.io)).toBe(EXIT.ok)
    const json = JSON.parse(t.out()) as { summary: { suites: { id: string }[] }; speed: { url: string; profiles: Record<string, { load_ms?: number; transfer_bytes?: number }> }[] }
    // --profile turns the browser suites on.
    expect(json.summary.suites.map((s) => s.id)).toEqual(['links', 'a11y', 'performance'])
    expect(json.speed.length).toBeGreaterThan(0)
    for (const row of json.speed) {
      expect(Object.keys(row.profiles)).toEqual(['desktop', 'phone'])
      expect(row.profiles.phone!.load_ms).toBeGreaterThan(0)
    }
    expect(readFileSync(join(cwd, '.webtrax', 'runs', runs()[0]!, 'report.md'), 'utf8')).toContain('| Page | Desktop LCP | Desktop CLS | Desktop weight | Phone LCP | Phone CLS | Phone weight |')
    expect(await main(['check', `${fixture.origin}/`, '--profile', 'tablet'], io().io)).toBe(EXIT.usage)
  }, 120_000)
})

describe('--scan and targeted checks', () => {
  const spec = (flags: Parameters<typeof buildSpec>[1], config: Parameters<typeof buildSpec>[0] = loadConfig(tmpdir()).config) => buildSpec(config, { url: 'https://example.com/', ...flags }, 'job')

  it('expands a profile into the spec, under flags and webtrax.yml', () => {
    const quick = spec({ scan: 'quick' })
    expect(quick.profile).toBe('quick')
    expect(Object.keys(quick.suites!)).toEqual(['links', 'security', 'seo', 'ai_readiness', 'performance'])
    expect(quick.limits?.max_pages).toBe(50)
    expect(quick.suites!.seo).toEqual({ enabled: true, config: { start_only: true } })
    expect(quick.browser).toEqual({ profiles: ['phone'] })
    // Flags win over the profile.
    expect(spec({ scan: 'quick', maxPages: 10, suites: ['links', 'seo'] })).toMatchObject({ limits: { max_pages: 10 }, suites: { links: { enabled: true }, seo: { enabled: true } } })
    expect(Object.keys(spec({ scan: 'quick', suites: ['links', 'seo'] }).suites!)).toEqual(['links', 'seo'])
    // webtrax.yml turning a suite off wins too.
    const off = { ...loadConfig(tmpdir()).config, suites: { a11y: { enabled: false } } }
    expect(Object.keys(spec({ scan: 'deep' }, off).suites!)).not.toContain('a11y')
    // No profile: as before.
    expect(spec({}).profile).toBeUndefined()
    expect(Object.keys(spec({}).suites!)).toEqual(['links', 'security', 'seo', 'content', 'ai_readiness'])
  })

  it('--urls means targeted: paths resolve on the target, and the suites follow --rules', () => {
    const t = spec({ urls: ['/pricing', 'https://example.com/signup'], rules: ['links.broken', 'seo.title'] })
    expect(t).toMatchObject({ profile: 'targeted', target: { start_url: 'https://example.com/', urls: ['https://example.com/pricing', 'https://example.com/signup'] }, rules: ['links.broken', 'seo.title'] })
    expect(Object.keys(t.suites!)).toEqual(['links', 'seo'])
    expect(() => spec({ scan: 'targeted' })).toThrow(/--urls/)
    expect(() => spec({ scan: 'quick', urls: ['/a'] })).toThrow(/targeted/)
    expect(() => spec({ urls: Array.from({ length: 201 }, (_, i) => `/p${i}`) })).toThrow(/200/)
  })

  it('checks only the pages named and reports only the rules asked for', async () => {
    fresh()
    const t = io()
    expect(await main(['check', `${fixture.origin}/`, ...FAST, '--urls', '/blog', '--rules', 'links.broken', '--stdout', 'json', '--fail-on', 'none'], t.io)).toBe(EXIT.ok)
    const json = JSON.parse(t.out()) as { summary: { pages: { crawled: number } }; findings: { rule_id: string; url: string }[] }
    expect(json.summary.pages.crawled).toBe(1)
    expect(json.findings.map((f) => [f.rule_id, new URL(f.url).pathname])).toEqual([['links.broken.internal', '/server-error']])
    expect(readFileSync(join(cwd, '.webtrax', 'runs', runs()[0]!, 'report.md'), 'utf8')).toContain('- Scan: Targeted check of 1 URL, rules links.broken')
    expect(await main(['check', `${fixture.origin}/`, '--scan', 'huge'], io().io)).toBe(EXIT.usage)
    expect(await main(['check', `${fixture.origin}/`, '--urls', '/blog', '--rules', 'links.nothing'], io().io)).toBe(EXIT.usage)
  })

  it('release-gate fails on high findings unless told otherwise', async () => {
    fresh()
    expect(await main(['check', `${fixture.origin}/`, ...FAST, '--scan', 'release-gate', '--suites', 'links', '--quiet'], io().io)).toBe(EXIT.findings)
  })
})

describe('webtrax.yml content.dictionary', () => {
  it('hands the site\'s list of terms to the content suite, and refuses a malformed list', async () => {
    fresh()
    writeFileSync(join(cwd, 'webtrax.yml'), `version: 1\ntarget: ${fixture.origin}/\nfail_on: none\ncontent:\n  dictionary:\n    - { term: "Blog", use: "Journal" }\n    - "a term that is nowhere"\n`)
    const t = io()
    expect(await main(['check', ...FAST, '--suites', 'content', '--stdout', 'json'], t.io)).toBe(EXIT.ok)
    const found = (JSON.parse(t.out()) as { findings: { rule_id: string; evidence: { term?: string; use?: string } }[] }).findings.filter((f) => f.rule_id === 'content.dictionary')
    expect(found.length).toBeGreaterThan(0)
    expect(found.every((f) => f.evidence.term === 'Blog' && f.evidence.use === 'Journal')).toBe(true)
    writeFileSync(join(cwd, 'webtrax.yml'), 'version: 1\ncontent:\n  dictionary: ["x"]\n')
    expect(await main(['check', `${fixture.origin}/`, ...FAST], io().io)).toBe(EXIT.usage)
  })
})

describe('diff and explain', () => {
  it('diff compares the last two runs by fingerprint', async () => {
    fresh()
    await main(['check', `${fixture.origin}/`, ...FAST, '--quiet', '--suites', 'links'], io().io)
    await main(['check', `${fixture.origin}/`, ...FAST, '--quiet'], io().io)
    const t = io()
    expect(await main(['diff'], t.io)).toBe(EXIT.ok)
    expect(t.out()).toMatch(/^New \([1-9]\d*\)/)
    expect(t.out()).toContain('Fixed (0)')
  })

  it('explain prints guidance for a rule and for a finding id from the latest run', async () => {
    const r = io()
    expect(await main(['explain', 'links.broken.internal'], r.io)).toBe(EXIT.ok)
    expect(r.out()).toContain('How to fix:')
    const md = io()
    await main(['check', `${fixture.origin}/`, ...FAST, '--stdout', 'md', '--suites', 'links'], md.io)
    const id = /`links\.broken\.internal` `([0-9a-f]{10})`/.exec(md.out())![1]!
    const f = io()
    expect(await main(['explain', id], f.io)).toBe(EXIT.ok)
    expect(f.out()).toContain(`Finding ${id}`)
    expect(await main(['explain', 'nothing.like.this'], io().io)).toBe(EXIT.usage)
  })
})

describe('the built executable', () => {
  const bin = join(import.meta.dirname, '..', 'dist', 'webtrax.js')
  beforeAll(() => { execFileSync('node', [join(import.meta.dirname, '..', 'scripts', 'build.mjs')]) }, 60_000)

  it('prints its version and help', () => {
    const pkg = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'package.json'), 'utf8')) as { version: string }
    expect(execFileSync('node', [bin, '--version'], { encoding: 'utf8' }).trim()).toBe(pkg.version)
    expect(VERSION).toBe('0.0.0-dev') // unbundled source has no version baked in
    expect(execFileSync('node', [bin, '--help'], { encoding: 'utf8' })).toContain('Exit codes')
  })

  it('checks a site as a real process, with the exit code and report on disk', async () => {
    const dir = fresh()
    // Async: the fixture server lives in this process, so a sync spawn would starve it.
    const r = await promisify(execFile)('node', [bin, 'check', `${fixture.origin}/`, ...FAST], { cwd: dir, encoding: 'utf8' }).then(
      ({ stdout }) => ({ code: 0, stdout }),
      (e: { code: number; stdout: string }) => ({ code: e.code, stdout: e.stdout }),
    )
    expect(r.code).toBe(EXIT.findings)
    expect(r.stdout).toContain('Broken internal link')
    expect(runs(dir)).toHaveLength(1)
    rmSync(dir, { recursive: true, force: true })
  }, 60_000)

  it('serves MCP over stdio, as Claude Code or Cursor would launch it', async () => {
    const dir = fresh()
    const client = new Client({ name: 'stdio-test', version: '1' })
    await client.connect(new StdioClientTransport({ command: 'node', args: [bin, 'mcp'], cwd: dir, stderr: 'ignore' }))
    try {
      expect((await client.listTools()).tools.map((t) => t.name)).toContain('audit_page')
      const r = (await client.callTool({ name: 'check_urls', arguments: { urls: [`${fixture.origin}/missing`] } })) as { content: { text: string }[] }
      expect(JSON.parse(r.content[0]!.text).results[0].classification).toBe('broken')
    } finally {
      await client.close()
    }
  })
})
