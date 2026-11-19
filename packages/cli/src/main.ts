/**
 * `webtrax`: the command-line runner (C05.6). `main(argv, io)` does the work
 * and returns the exit code, so tests drive it without a subprocess; bin.ts
 * wires it to the process.
 *
 * Exit codes (rebuild/06): 0 ok, 1 findings at or above --fail-on,
 * 2 usage or config error, 3 the target could not be crawled.
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { lookup } from 'node:dns/promises'
import { join, relative, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { crawl, LocalSink, MemorySink, TeeSink, type CrawlResult } from '@webtrax/engine'
import { createGuardedFetch } from '@webtrax/net-guard'
import { atLeast, BOT_USER_AGENT } from '@webtrax/protocol'
import { buildReport, renderConsole, renderHtml, renderJson, renderJunit, renderMarkdown, renderSarif, shortId } from '@webtrax/reporters'
import { serveMcp } from './mcp'
import { listRuns, readRun as readRunAt, RULES, runsDir, SUITES } from './runs'
import { buildSpec, CONFIG_FILE, ConfigError, configTemplate, loadConfig, normaliseTarget, parseFailOn, parseHeaders, parseSuites, type FailOn } from './config'

export const VERSION = typeof __WEBTRAX_VERSION__ === 'string' ? __WEBTRAX_VERSION__ : '0.0.0-dev'
declare const __WEBTRAX_VERSION__: string | undefined

export { RULES, SUITES } from './runs'
export const EXIT = { ok: 0, findings: 1, usage: 2, unreachable: 3 } as const

export interface Io {
  stdout: (text: string) => void
  stderr: (text: string) => void
  cwd: string
  /** True when stdout is a terminal (colour). */
  tty?: boolean
  /** Aborts a running check (Ctrl-C). */
  signal?: AbortSignal
}

export const HELP = `webtrax ${VERSION}: check a website for broken links, redirects, security headers, SEO basics and AI readiness

Usage
  webtrax check [url] [options]   crawl a site and report what is broken
  webtrax init [url] [--force]    write a webtrax.yml for this project
  webtrax diff <runA> <runB>      compare two runs: new, fixed and persisting findings
  webtrax explain <rule|finding>  how to fix a rule, or a finding from the latest run
  webtrax doctor                  check that this machine can run webtrax
  webtrax mcp [--allow-public]    local MCP server for coding agents (stdio)

Options for check
  --config <file>        config file (default: ./webtrax.yml if present)
  --max-pages <n>        pages to crawl (default 300)
  --max-depth <n>        link depth from the start page (default 10)
  --suites <list>        links,security,seo,ai_readiness,a11y,performance (default: links,security,seo,ai_readiness)
  --browser              also run the browser suites (a11y, performance); needs Chromium or Chrome
  --fail-on <severity>   exit 1 at this severity or worse: critical, high, medium, low, info, none (default high)
  --reports <list>       report files to write: html,md,json,sarif,junit (default html,md)
  --out <dir>            where runs are written: <dir>/runs/<time>/ (default ./.webtrax)
  --stdout <format>      what to print: console, md, json (default console)
  --quiet                print nothing; use the exit code and report files
  --allow-private        allow private network targets (automatic for localhost and private IPs)
  --ignore-robots        crawl paths robots.txt disallows (only for sites you run)
  --no-external          do not check links to other sites
  --rps <n>              requests per second per host (default 2)
  --concurrency <n>      parallel requests (default 4)
  --time-budget <s>      stop after this many seconds and report what was found (default 600)
  --ignore <rules>       rule ids to leave out of reports and the exit code, e.g. seo.noindex
  --header <name:value>  send a header to the site itself (never to other hosts), e.g. a protected
                         preview's x-vercel-protection-bypass:<secret>; repeatable; never written to reports

Exit codes: 0 ok, 1 findings at or above --fail-on, 2 usage or config error, 3 site unreachable.
The crawler identifies itself as ${BOT_USER_AGENT}.
`

const int = (name: string, v: string | undefined) => {
  if (v === undefined) return undefined
  const n = Number(v)
  if (!Number.isFinite(n) || n <= 0) throw new ConfigError(`--${name} must be a positive number`)
  return n
}

export async function main(argv: string[], io: Io): Promise<number> {
  const [command, ...rest] = argv
  try {
    switch (command) {
      case 'check': return await check(rest, io)
      case 'init': return init(rest, io)
      case 'diff': return diff(rest, io)
      case 'explain': return explain(rest, io)
      case 'doctor': return await doctor(io)
      case 'mcp': return await mcp(rest, io)
      case '--version': case '-v': case 'version': io.stdout(`${VERSION}\n`); return EXIT.ok
      case undefined: case '--help': case '-h': case 'help': io.stdout(HELP); return command === undefined ? EXIT.usage : EXIT.ok
      default:
        io.stderr(`webtrax: unknown command "${command}"\n\n${HELP}`)
        return EXIT.usage
    }
  } catch (error) {
    if (error instanceof ConfigError || (error as { code?: string }).code?.startsWith('ERR_PARSE_ARGS')) {
      io.stderr(`webtrax: ${(error as Error).message}\n`)
      return EXIT.usage
    }
    throw error
  }
}

async function check(args: string[], io: Io): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      config: { type: 'string' }, 'max-pages': { type: 'string' }, 'max-depth': { type: 'string' }, suites: { type: 'string' },
      'fail-on': { type: 'string' }, reports: { type: 'string' }, out: { type: 'string' }, stdout: { type: 'string' }, quiet: { type: 'boolean' },
      'allow-private': { type: 'boolean' }, 'ignore-robots': { type: 'boolean' }, 'no-external': { type: 'boolean' }, rps: { type: 'string' },
      concurrency: { type: 'string' }, 'time-budget': { type: 'string' }, ignore: { type: 'string' }, browser: { type: 'boolean' },
      header: { type: 'string', multiple: true },
    },
  })
  if (positionals.length > 1) throw new ConfigError('check takes one URL')
  const { config } = loadConfig(io.cwd, values.config)
  const failOn: FailOn = values['fail-on'] ? parseFailOn(values['fail-on']) : (config.fail_on ?? 'high')
  const reports = values.reports ? values.reports.split(',').map((r) => r.trim()).filter(Boolean) : (config.reports ?? ['html', 'md'])
  for (const r of reports) if (!['html', 'md', 'json', 'sarif', 'junit'].includes(r)) throw new ConfigError('--reports takes html, md, json, sarif and junit')
  const ignore = new Set(values.ignore ? values.ignore.split(',').map((r) => r.trim()).filter(Boolean) : (config.ignore ?? []))
  for (const id of ignore) if (!RULES.some((r) => r.id === id)) throw new ConfigError(`--ignore: unknown rule ${id} (see webtrax explain or the rules reference)`)
  const stdoutFormat = values.stdout ?? 'console'
  if (!['console', 'md', 'json'].includes(stdoutFormat)) throw new ConfigError('--stdout must be console, md or json')

  const startedAt = new Date()
  const jobId = `cli-${startedAt.toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}`
  const spec = buildSpec(config, {
    ...(positionals[0] ? { url: positionals[0] } : {}),
    ...(values['max-pages'] ? { maxPages: int('max-pages', values['max-pages'])! } : {}),
    ...(values['max-depth'] ? { maxDepth: Number(values['max-depth']) } : {}),
    ...(values.concurrency ? { concurrency: int('concurrency', values.concurrency)! } : {}),
    ...(values.rps ? { rps: int('rps', values.rps)! } : {}),
    ...(values['time-budget'] ? { timeBudget: int('time-budget', values['time-budget'])! } : {}),
    ...(values.suites ? { suites: parseSuites(values.suites) } : {}),
    browser: values.browser ?? false,
    allowPrivate: values['allow-private'] ?? false,
    ignoreRobots: values['ignore-robots'] ?? false,
    noExternal: values['no-external'] ?? false,
    ...(values.header?.length ? { headers: parseHeaders(values.header) } : {}),
  }, jobId)

  const local = new LocalSink(io.cwd, startedAt, values.out ? join(resolve(io.cwd, values.out), 'runs') : undefined)
  const memory = new MemorySink()
  if (!values.quiet && stdoutFormat === 'console') io.stderr(`Checking ${spec.target.start_url} …\n`)

  let result: CrawlResult
  try {
    result = await crawl(spec, { sink: new TeeSink([local, memory]), suites: SUITES, runner: { name: '@webtrax/cli', version: VERSION }, ...(io.signal ? { signal: io.signal } : {}) })
  } finally {
    await local.close()
  }

  // Ignored rules stay in run.ndjson but leave the reports and the exit code.
  const report = buildReport(memory.records.filter((r) => r.type !== 'finding' || !ignore.has(r.rule_id)), RULES)
  const written: string[] = []
  const write = (name: string, text: string) => { const file = join(local.dir, name); writeFileSync(file, text); written.push(file) }
  if (reports.includes('html')) write('report.html', renderHtml(report))
  if (reports.includes('md')) write('report.md', renderMarkdown(report))
  if (reports.includes('json')) write('report.json', renderJson(report))
  if (reports.includes('sarif')) write('report.sarif', renderSarif(report))
  if (reports.includes('junit')) write('report.junit.xml', renderJunit(report))
  const shown = written.find((f) => f.endsWith('.html')) ?? local.file

  if (!values.quiet) {
    if (stdoutFormat === 'md') io.stdout(renderMarkdown(report))
    else if (stdoutFormat === 'json') io.stdout(renderJson(report))
    else {
      const rel = relative(io.cwd, shown)
      io.stdout(renderConsole(report, { color: io.tty ?? false, reportPath: rel && !rel.startsWith('..') ? rel : shown }))
    }
  }
  for (const e of result.suiteErrors) io.stderr(`webtrax: suite ${e.suite} failed on ${e.url ?? 'site'}: ${e.message}\n`)

  if (result.summary.status === 'failed') {
    if (!values.quiet) io.stderr(`webtrax: could not crawl ${spec.target.start_url} (${failureReason(result.summary)})\n`)
    return EXIT.unreachable
  }
  if (failOn !== 'none' && report.findings.some((f) => atLeast(f.severity, failOn))) return EXIT.findings
  return EXIT.ok
}

function init(args: string[], io: Io): number {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { force: { type: 'boolean' } } })
  const file = join(io.cwd, CONFIG_FILE)
  if (existsSync(file) && !values.force) throw new ConfigError(`${CONFIG_FILE} already exists (use --force to replace it)`)
  const target = positionals[0] ? normaliseTarget(positionals[0]) : 'https://example.com/'
  writeFileSync(file, configTemplate(target))
  io.stdout(`Wrote ${CONFIG_FILE} for ${target}. Run: webtrax check\n`)
  return EXIT.ok
}

const runDirs = (root: string) => listRuns(root).map((id) => join(runsDir(root), id))
const readRun = (io: Io, ref: string) => readRunAt(io.cwd, ref)

function diff(args: string[], io: Io): number {
  const { positionals } = parseArgs({ args, allowPositionals: true, options: {} })
  const runs = runDirs(io.cwd)
  const [a, b] = positionals.length === 2 ? positionals : positionals.length === 0 && runs.length >= 2 ? runs.slice(-2) : []
  if (!a || !b) throw new ConfigError('diff needs two runs (or at least two runs in .webtrax/runs)')
  const before = buildReport(readRun(io, a), RULES).findings
  const after = buildReport(readRun(io, b), RULES).findings
  const had = new Set(before.map((f) => f.fingerprint))
  const has = new Set(after.map((f) => f.fingerprint))
  const added = after.filter((f) => !had.has(f.fingerprint))
  const fixed = before.filter((f) => !has.has(f.fingerprint))
  const line = (f: (typeof after)[number]) => `  ${f.severity.padEnd(8)} ${f.title}: ${f.url ?? 'site-wide'} [${f.id}]`
  io.stdout([`New (${added.length})`, ...added.map(line), `Fixed (${fixed.length})`, ...fixed.map(line), `Persisting: ${after.length - added.length}`].join('\n') + '\n')
  return EXIT.ok
}

function explain(args: string[], io: Io): number {
  const { positionals } = parseArgs({ args, allowPositionals: true, options: {} })
  const key = positionals[0]
  if (!key) throw new ConfigError('explain needs a rule id (links.broken.internal) or a finding id from a report')
  let rule = RULES.find((r) => r.id === key)
  let context = ''
  if (!rule) {
    const latest = runDirs(io.cwd).at(-1)
    const finding = latest ? buildReport(readRun(io, latest), RULES).findings.find((f) => f.id === key || f.fingerprint === key || shortId(f.fingerprint).startsWith(key)) : undefined
    if (!finding) throw new ConfigError(`no rule or finding "${key}" (finding ids come from the latest run in .webtrax/runs)`)
    rule = finding.rule
    context = `Finding ${finding.id}: ${finding.url ?? 'site-wide'}${finding.sources.length ? `, seen on ${finding.sources.slice(0, 3).join(', ')}` : ''}\n`
  }
  if (!rule) throw new ConfigError(`no guidance for ${key}`)
  io.stdout(`${rule.title} (${rule.id}, ${rule.severity})\n${context}\nWhy it matters: ${rule.why}\nHow to fix: ${rule.fix}\nDocs: https://docs.webtrax.dev/rules/${rule.docs_slug}/\n`)
  return EXIT.ok
}

async function doctor(io: Io): Promise<number> {
  const results: { ok: boolean; what: string; fix?: string }[] = []
  const [major = 0, minor = 0] = process.versions.node.split('.').map(Number)
  results.push({ ok: major > 22 || (major === 22 && minor >= 19), what: `Node.js ${process.versions.node}`, fix: 'Install Node.js 22.19 or newer.' })
  try {
    await lookup('webtrax.dev')
    results.push({ ok: true, what: 'DNS resolves public names' })
  } catch {
    results.push({ ok: false, what: 'DNS resolves public names', fix: 'Check your network or DNS settings.' })
  }
  const fetch = createGuardedFetch()
  try {
    const { response } = await fetch('https://webtrax.dev/bot', { headers: { 'user-agent': BOT_USER_AGENT }, signal: AbortSignal.timeout(10_000) })
    await response.body?.cancel()
    results.push({ ok: response.status < 500, what: `HTTPS reaches webtrax.dev (${response.status})` })
  } catch (e) {
    results.push({ ok: false, what: 'HTTPS reaches webtrax.dev', fix: `Check proxies and firewalls (${(e as Error).message}).` })
  } finally {
    await fetch.close()
  }
  try {
    const { chromium } = await import('playwright-core')
    const browser = await chromium.launch().catch(() => chromium.launch({ channel: 'chrome' }))
    await browser.close()
    results.push({ ok: true, what: 'Chromium or Chrome for --browser (a11y, performance)' })
  } catch {
    results.push({ ok: false, what: 'Chromium or Chrome for --browser (a11y, performance)', fix: 'Optional. Install with "npx playwright@1.57.0 install chromium", or install Google Chrome.' })
  }
  try {
    mkdirSync(join(io.cwd, '.webtrax'), { recursive: true })
    results.push({ ok: true, what: 'Can write .webtrax/ in this directory' })
  } catch {
    results.push({ ok: false, what: 'Can write .webtrax/ in this directory', fix: 'Run from a directory you can write to, or pass --out.' })
  }
  try {
    const { path } = loadConfig(io.cwd)
    results.push({ ok: true, what: path ? `${CONFIG_FILE} is valid` : `No ${CONFIG_FILE} (optional; webtrax init writes one)` })
  } catch (e) {
    results.push({ ok: false, what: `${CONFIG_FILE} is valid`, fix: (e as Error).message })
  }
  for (const r of results) io.stdout(`${r.ok ? '✓' : '✗'} ${r.what}${!r.ok && r.fix ? `\n  ${r.fix}` : ''}\n`)
  return results.every((r) => r.ok) ? EXIT.ok : EXIT.usage
}

async function mcp(args: string[], io: Io): Promise<number> {
  const { values } = parseArgs({ args, options: { 'allow-public': { type: 'boolean' } } })
  await serveMcp({ root: io.cwd, allowPublic: values['allow-public'] ?? false, version: VERSION })
  return EXIT.ok
}

/** Why a run failed, for the terminal: the start page's status or fetch error when known. */
export function failureReason(summary: { error?: string | undefined; start?: { status: number | null; error?: string | undefined } | undefined }): string {
  const what = (summary.error ?? 'error').replace(/_/g, ' ')
  const start = summary.start
  if (!start) return what
  if (start.status !== null) return `${what}: HTTP ${start.status}${start.status === 401 || start.status === 403 ? ', a firewall or login may be blocking WebtraxBot' : ''}`
  return start.error ? `${what}: ${start.error.replace(/_/g, ' ')}` : what
}
