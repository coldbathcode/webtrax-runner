/**
 * `webtrax.yml` (rebuild/08 §Configuration file, trimmed to what the runner
 * does today) and how it combines with command-line flags into a JobSpec.
 * Flags win over the file; the file wins over defaults.
 */
import { existsSync, readFileSync } from 'node:fs'
import { isIP } from 'node:net'
import { resolve } from 'node:path'
import { parse as parseYaml } from 'yaml'
import { z } from 'zod'
import { BROWSER_PROFILES, SEVERITIES, type BrowserProfileId, type JobSpecInput, type Severity, type SuiteId } from '@webtrax/protocol'

export const CONFIG_FILE = 'webtrax.yml'
export const AVAILABLE_SUITES = ['links', 'security', 'seo', 'content', 'ai_readiness', 'a11y', 'performance'] as const satisfies readonly SuiteId[]
/** On unless turned off. The browser suites (a11y, performance) need Chromium, so they are opt-in. */
export const DEFAULT_SUITES: readonly AvailableSuite[] = ['links', 'security', 'seo', 'content', 'ai_readiness']
export const BROWSER_SUITES: readonly AvailableSuite[] = ['a11y', 'performance']
export type AvailableSuite = (typeof AVAILABLE_SUITES)[number]
export type FailOn = Severity | 'none'

const Config = z.strictObject({
  version: z.literal(1).default(1),
  target: z.string().optional(),
  scope: z.strictObject({
    include: z.array(z.string()).optional(),
    exclude: z.array(z.string()).optional(),
    check_external: z.boolean().optional(),
    respect_robots: z.boolean().optional(),
    allow_private: z.boolean().optional(),
  }).optional(),
  limits: z.strictObject({
    max_pages: z.int().positive().optional(),
    max_depth: z.int().min(0).optional(),
    concurrency: z.int().positive().optional(),
    per_host_rps: z.number().positive().optional(),
    time_budget_s: z.int().positive().optional(),
  }).optional(),
  suites: z.partialRecord(z.enum(AVAILABLE_SUITES), z.strictObject({ enabled: z.boolean() })).optional(),
  /** Browser profiles the browser suites load pages as: `desktop` (default), `phone`, or both. */
  browser: z.strictObject({ profiles: z.array(z.enum(BROWSER_PROFILES)).min(1).max(BROWSER_PROFILES.length) }).optional(),
  /** The content suite's settings. `dictionary`: terms the site should no longer use, each with what to use instead. */
  content: z.strictObject({
    dictionary: z.array(z.union([z.string().min(2).max(80), z.strictObject({ term: z.string().min(2).max(80), use: z.string().max(120).optional() })])).max(200).optional(),
  }).optional(),
  /** Pages that matter most (pricing, sign-up, checkout): broken links on them, on the route to them or a click from them rank first (`rank_broken_links`). */
  key_pages: z.array(z.string().min(1).max(2000)).max(20).optional(),
  fail_on: z.enum([...SEVERITIES, 'none']).optional(),
  reports: z.array(z.enum(['html', 'md', 'json', 'sarif', 'junit'])).optional(),
  /** Rule ids to leave out of reports and the exit code (they stay in run.ndjson). */
  ignore: z.array(z.string().regex(/^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$/)).optional(),
})
export type Config = z.output<typeof Config>

export class ConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ConfigError'
  }
}

/** Reads `webtrax.yml` (or an explicit file). Returns {} when there is none and none was asked for. */
export function loadConfig(cwd: string, explicit?: string): { config: Config; path: string | null } {
  const path = resolve(cwd, explicit ?? CONFIG_FILE)
  if (!existsSync(path)) {
    if (explicit) throw new ConfigError(`config file not found: ${explicit}`)
    return { config: Config.parse({}), path: null }
  }
  let raw: unknown
  try {
    raw = parseYaml(readFileSync(path, 'utf8')) ?? {}
  } catch (e) {
    throw new ConfigError(`${path}: not valid YAML: ${(e as Error).message}`)
  }
  const parsed = Config.safeParse(raw)
  if (!parsed.success) throw new ConfigError(`${path}: ${parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ')}`)
  return { config: parsed.data, path }
}

/** Local targets (dev servers): private targets are allowed for these without --allow-private. */
export function isLocalTarget(url: string): boolean {
  const host = new URL(url).hostname.replace(/^\[|\]$/g, '').toLowerCase()
  if (host === 'localhost' || host.endsWith('.localhost')) return true
  if (isIP(host) === 4) return /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host)
  if (isIP(host) === 6) return host === '::1' || /^f[cd]/.test(host)
  return false
}

export interface CheckFlags {
  url?: string
  maxPages?: number
  maxDepth?: number
  concurrency?: number
  rps?: number
  timeBudget?: number
  suites?: AvailableSuite[]
  /** Add the browser suites (a11y, performance) to whatever else runs. */
  browser?: boolean
  /** Browser profiles to load pages as (`--profile desktop,phone`); turns the browser suites on. */
  profiles?: BrowserProfileId[]
  allowPrivate?: boolean
  ignoreRobots?: boolean
  noExternal?: boolean
  /** Sent to the target's origin only (`auth.headers`). */
  headers?: Record<string, string>
}

/** Adds a scheme when the user typed a bare host (`webtrax check example.com`). */
export function normaliseTarget(input: string): string {
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(input) ? input : `${/^(localhost|127\.|\[?::1)/i.test(input) ? 'http' : 'https'}://${input}`
  let url: URL
  try {
    url = new URL(withScheme)
  } catch {
    throw new ConfigError(`not a valid URL: ${input}`)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new ConfigError(`only http and https URLs can be checked: ${input}`)
  return url.toString()
}

export function buildSpec(config: Config, flags: CheckFlags, jobId: string): JobSpecInput {
  const target = flags.url ?? config.target
  if (!target) throw new ConfigError('no URL to check: pass one (webtrax check https://example.com) or set target in webtrax.yml')
  const startUrl = normaliseTarget(target)
  const base = flags.suites ?? AVAILABLE_SUITES.filter((s) => config.suites?.[s]?.enabled ?? DEFAULT_SUITES.includes(s))
  const profiles = flags.profiles ?? config.browser?.profiles
  const suites = flags.browser || flags.profiles ? [...new Set([...base, ...BROWSER_SUITES])] : base
  const limits = config.limits ?? {}
  return {
    spec_version: 1,
    job_id: jobId,
    target: { start_url: startUrl },
    scope: {
      include: config.scope?.include ?? [],
      exclude: config.scope?.exclude ?? [],
      check_external: flags.noExternal ? false : (config.scope?.check_external ?? true),
      respect_robots: flags.ignoreRobots ? false : (config.scope?.respect_robots ?? true),
      allow_private: flags.allowPrivate || config.scope?.allow_private || isLocalTarget(startUrl),
    },
    limits: {
      max_pages: flags.maxPages ?? limits.max_pages ?? 300,
      max_depth: flags.maxDepth ?? limits.max_depth ?? 10,
      concurrency: flags.concurrency ?? limits.concurrency ?? 4,
      per_host_rps: flags.rps ?? limits.per_host_rps ?? 2,
      time_budget_s: flags.timeBudget ?? limits.time_budget_s ?? 600,
    },
    suites: Object.fromEntries(suites.map((s) => [s, { enabled: true, ...(s === 'content' && config.content?.dictionary?.length ? { config: { dictionary: config.content.dictionary } } : {}) }])),
    ...(flags.headers && Object.keys(flags.headers).length ? { auth: { headers: flags.headers } } : {}),
    ...(profiles ? { browser: { profiles } } : {}),
    labels: { source: 'cli' },
  }
}

/** `--header name:value` (or `name: value`), repeatable. */
export function parseHeaders(values: string[]): Record<string, string> {
  const out: Record<string, string> = {}
  for (const v of values) {
    // Errors name the header at most, never its value (it is often a secret).
    const i = v.indexOf(':')
    if (i <= 0) throw new ConfigError('--header takes name:value')
    const name = v.slice(0, i).trim()
    const value = v.slice(i + 1).trim()
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name)) throw new ConfigError('--header: the name has characters a header name cannot have')
    if (!value || /[\r\n\0]/.test(value)) throw new ConfigError(`--header ${name}: the value is empty or has a line break`)
    out[name.toLowerCase()] = value
  }
  return out
}

export function parseFailOn(value: string): FailOn {
  if (value === 'none' || (SEVERITIES as readonly string[]).includes(value)) return value as FailOn
  throw new ConfigError(`--fail-on must be one of ${[...SEVERITIES, 'none'].join(', ')}`)
}

export function parseSuites(value: string): AvailableSuite[] {
  const list = value.split(',').map((s) => s.trim()).filter(Boolean)
  const bad = list.filter((s) => !(AVAILABLE_SUITES as readonly string[]).includes(s))
  if (bad.length || !list.length) throw new ConfigError(`--suites takes a comma-separated list of: ${AVAILABLE_SUITES.join(', ')}`)
  return list as AvailableSuite[]
}

export function parseProfiles(value: string): BrowserProfileId[] {
  const list = [...new Set(value.split(',').map((s) => s.trim()).filter(Boolean))]
  const bad = list.filter((s) => !(BROWSER_PROFILES as readonly string[]).includes(s))
  if (bad.length || !list.length) throw new ConfigError(`--profile takes a comma-separated list of: ${BROWSER_PROFILES.join(', ')}`)
  return list as BrowserProfileId[]
}

export function configTemplate(target: string): string {
  return `# Webtrax configuration: https://docs.webtrax.dev/configuration/
version: 1
target: ${target}

scope:
  # Path prefixes to crawl (* is a wildcard); empty means the whole site.
  include: []
  exclude: []
  check_external: true   # check links to other sites (they are never crawled)
  respect_robots: true

limits:
  max_pages: 300
  max_depth: 10
  per_host_rps: 2        # requests per second to each host
  time_budget_s: 600

suites:
  links: { enabled: true }
  security: { enabled: true }
  seo: { enabled: true }
  # Need Chromium (npx playwright@1.57.0 install chromium, or Google Chrome):
  a11y: { enabled: false }
  performance: { enabled: false }

# Words the site should no longer use (old product names, retired prices), found by the content suite.
# content:
#   dictionary:
#     - { term: "Acme Classic", use: "Acme One" }
#     - "free forever"

# Exit with code 1 when a finding is at least this severe (critical, high, medium, low, info, none).
fail_on: high

# Report files written to the run directory (.webtrax/runs/<time>/): html, md, json, sarif, junit.
reports: [html, md]

# Rule ids to leave out of reports and the exit code, e.g. [seo.noindex] on a staging site.
ignore: []
`
}
