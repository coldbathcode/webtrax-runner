/**
 * Accessibility suite (C05.10 / C06.4): axe-core's WCAG 2.0, 2.1 and 2.2
 * level A and AA rules, run in Chromium on a sample of crawled pages
 * (default 25). axe is evaluated through the DevTools protocol, so the
 * site's Content-Security-Policy cannot block it, and it only reads the page.
 *
 * Every axe rule is declared up front as `a11y.<rule>` (so each gets a docs
 * page and a stable id). Severity follows axe's impact for each result:
 * critical → high, serious → medium, moderate → low, minor → info.
 */
import { createRequire } from 'node:module'
import type { CheckSuite } from '@webtrax/engine'
import type { RuleMeta, Severity } from '@webtrax/protocol'

interface AxeRuleInfo { ruleId: string; description: string; help: string; helpUrl: string; tags: string[] }
interface AxeNode { target: unknown[]; html: string; failureSummary?: string }
interface AxeViolation { id: string; impact?: string | null; help: string; nodes: AxeNode[]; tags: string[] }
interface AxeModule { version: string; source: string; getRules(tags?: string[]): AxeRuleInfo[] }

const axe = createRequire(import.meta.url)('axe-core') as AxeModule
export const AXE_VERSION = axe.version
export const WCAG_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']

const IMPACT: Record<string, Severity> = { critical: 'high', serious: 'medium', moderate: 'low', minor: 'info' }
export const ruleIdFor = (axeId: string) => `a11y.${axeId.replace(/-/g, '_')}`

export const A11Y_RULES: RuleMeta[] = axe.getRules(WCAG_TAGS).map((r) => ({
  id: ruleIdFor(r.ruleId),
  suite: 'a11y',
  title: r.help.replace(/\.$/, '').slice(0, 200),
  version: 1,
  severity: 'medium',
  why: `${r.description.replace(/\.?$/, '.')} WCAG: ${r.tags.filter((t) => /^wcag\d{3,}$/.test(t)).map((t) => t.replace(/^wcag(\d)(\d)(\d+)$/, '$1.$2.$3')).join(', ') || 'best practice'}.`,
  fix: `${r.help.replace(/\.?$/, '.')} Deque's guidance for this rule: ${r.helpUrl.replace(/\?.*$/, '')}`,
  docs_slug: `a11y-${r.ruleId}`,
  tags: r.tags.filter((t) => t.startsWith('wcag') || t.startsWith('cat.')),
}))
const KNOWN = new Set(A11Y_RULES.map((r) => r.id))

/** Evidence capped well under the protocol's 2 KB. */
function evidence(v: AxeViolation) {
  const nodes = v.nodes.slice(0, 3).map((n) => ({ target: n.target.map(String).join(' ').slice(0, 120), html: n.html.slice(0, 160) }))
  return { impact: v.impact ?? 'unknown', count: v.nodes.length, nodes }
}

export const a11ySuite: CheckSuite = {
  id: 'a11y',
  version: `1.0.0+axe.${AXE_VERSION}`,
  requires: ['http', 'browser'],
  rules: A11Y_RULES,
  defaultSample: 25,
  // What is reachable and readable depends on the screen: checked as each browser profile (desktop, phone).
  everyProfile: true,

  async onBrowserPage(ctx, bp) {
    if (bp.status === null || bp.status >= 400) return
    await bp.page.evaluate(axe.source)
    const violations = (await bp.page.evaluate(
      (tags) => (globalThis as unknown as { axe: { run(ctx: unknown, opts: unknown): Promise<{ violations: unknown[] }> } }).axe.run(document, { runOnly: { type: 'tag', values: tags }, resultTypes: ['violations'] }).then((r) => r.violations),
      WCAG_TAGS,
    )) as AxeViolation[]
    for (const v of violations) {
      const ruleId = ruleIdFor(v.id)
      if (!KNOWN.has(ruleId)) continue
      await ctx.emit({ rule_id: ruleId, url: bp.url, severity: IMPACT[v.impact ?? ''] ?? 'medium', evidence: evidence(v) })
    }
  },
}

export default a11ySuite
