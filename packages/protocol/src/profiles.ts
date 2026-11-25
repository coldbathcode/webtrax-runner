/**
 * Scan profiles (C06.8; plan/06-check-suites/ai-readiness-and-monitors.md §4):
 * named sets of suites, limits and browser settings, so the CLI, the local
 * MCP server and Webtrax Cloud mean the same thing by "a quick check" or "a
 * deep scan".
 *
 * A profile is expanded into an ordinary job spec before the run starts
 * (`applyScanProfile`), and the spec records its name in `profile`. The run
 * record therefore shows exactly what ran, and a reader never has to know a
 * profile's contents to understand a run. Anything the caller sets itself
 * (flags, webtrax.yml, a hosted plan's ceilings) wins over the profile.
 *
 * Not the browser profiles (`desktop`, `phone`): those say what device the
 * browser stage loads pages as, and a scan profile picks some of them.
 */
import type { BrowserProfileId, Severity, SuiteId } from './enums'

export const SCAN_PROFILES = ['quick', 'standard', 'deep', 'release-gate', 'targeted'] as const
export type ScanProfileId = (typeof SCAN_PROFILES)[number]
/** What a spec built without a profile is called: everything was chosen by hand. */
export const CUSTOM_PROFILE = 'custom'

/** The most URLs a targeted scan checks. */
export const TARGETED_MAX_URLS = 200

export interface ScanProfile {
  id: ScanProfileId
  /** What a report calls it. */
  label: string
  /** One line for help text and docs. */
  description: string
  /** The suites that run, in order. */
  suites: readonly SuiteId[]
  /** Per-suite settings (`suites.<id>.config`): `start_only` limits a suite to the start page; `sample` is how many pages a browser suite loads. */
  config?: Partial<Record<SuiteId, Record<string, unknown>>>
  /** Limits the profile sets; unset ones are the caller's (a plan's cap, the CLI's defaults). */
  limits?: { max_pages?: number; max_depth?: number }
  /** The browser stage's devices, for profiles whose suites use it. */
  browser?: { profiles: readonly BrowserProfileId[]; extra_profile_pages?: number }
  /** The CLI's exit threshold when the caller sets none. */
  fail_on?: Severity
  /** Checks only the URLs the caller names (`target.urls`), without crawling. */
  urls?: 'required'
}

const HTTP_SUITES: readonly SuiteId[] = ['links', 'security', 'seo', 'content', 'ai_readiness']
const ALL_SUITES: readonly SuiteId[] = [...HTTP_SUITES, 'a11y', 'performance']

export const SCAN_PROFILE: Record<ScanProfileId, ScanProfile> = {
  quick: {
    id: 'quick', label: 'Quick check',
    description: 'Up to 50 pages for links; security, SEO and AI readiness on the start page; the start page\'s speed as a phone.',
    suites: ['links', 'security', 'seo', 'ai_readiness', 'performance'],
    config: { security: { start_only: true }, seo: { start_only: true }, ai_readiness: { start_only: true }, performance: { sample: 1 } },
    limits: { max_pages: 50 },
    browser: { profiles: ['phone'] },
  },
  standard: {
    id: 'standard', label: 'Standard scan',
    description: 'Every suite on every page up to the page limit; speed and accessibility on the top pages as a desktop, and the start page as a phone.',
    suites: ALL_SUITES,
    browser: { profiles: ['desktop', 'phone'], extra_profile_pages: 1 },
  },
  deep: {
    id: 'deep', label: 'Deep scan',
    description: 'Every suite; accessibility on up to 200 pages and speed on 25, each as a desktop and as a phone.',
    suites: ALL_SUITES,
    config: { a11y: { sample: 200 }, performance: { sample: 25 } },
    browser: { profiles: ['desktop', 'phone'] },
  },
  'release-gate': {
    id: 'release-gate', label: 'Release gate',
    description: 'For CI and preview deployments: every suite on up to 100 pages, the browser suites on the top 5 as a desktop, failing on high or worse.',
    suites: ALL_SUITES,
    config: { a11y: { sample: 5 }, performance: { sample: 5 } },
    limits: { max_pages: 100 },
    browser: { profiles: ['desktop'] },
    fail_on: 'high',
  },
  targeted: {
    id: 'targeted', label: 'Targeted check',
    description: `Only the URLs named (up to ${TARGETED_MAX_URLS}) and, if given, only the rules named: "is it fixed now?" in seconds, without a crawl.`,
    suites: HTTP_SUITES,
    urls: 'required',
  },
}

export const isScanProfile = (v: unknown): v is ScanProfileId => typeof v === 'string' && (SCAN_PROFILES as readonly string[]).includes(v)

/** The suites that own these rules (`links.broken.internal` → links), for a targeted check given rules and no suites. */
export const suitesOfRules = (rules: readonly string[]): SuiteId[] => [...new Set(rules.map((r) => r.split('.')[0] as SuiteId))]

/** True when `rule` is one of `rules` or under one of them (`links.broken` covers `links.broken.internal`). */
export const ruleSelected = (rule: string, rules: readonly string[] | undefined): boolean => !rules?.length || rules.some((r) => rule === r || rule.startsWith(`${r}.`))

export interface ProfiledSpecPart {
  profile: ScanProfileId
  suites: Partial<Record<SuiteId, { enabled: boolean; config: Record<string, unknown> }>>
  limits: { max_pages?: number; max_depth?: number }
  browser?: { profiles: BrowserProfileId[]; extra_profile_pages?: number }
}

/**
 * The spec fields a profile sets. `only` narrows the suites (the caller's
 * `--suites`, a site's chosen suites); `config` adds the caller's own suite
 * settings on top of the profile's.
 */
export function applyScanProfile(id: ScanProfileId, opts: { only?: readonly SuiteId[]; config?: Partial<Record<SuiteId, Record<string, unknown>>> } = {}): ProfiledSpecPart {
  const p = SCAN_PROFILE[id]
  const suites = opts.only ? p.suites.filter((s) => opts.only!.includes(s)).concat(id === 'targeted' ? opts.only.filter((s) => !p.suites.includes(s)) : []) : p.suites
  return {
    profile: id,
    suites: Object.fromEntries(suites.map((s) => [s, { enabled: true, config: { ...(p.config?.[s] ?? {}), ...(opts.config?.[s] ?? {}) } }])),
    limits: { ...(p.limits ?? {}) },
    ...(p.browser && suites.some((s) => s === 'a11y' || s === 'performance') ? { browser: { profiles: [...p.browser.profiles], ...(p.browser.extra_profile_pages ? { extra_profile_pages: p.browser.extra_profile_pages } : {}) } } : {}),
  }
}
