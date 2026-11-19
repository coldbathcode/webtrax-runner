/**
 * AI readiness (C06.6, first slice; plan/06-check-suites/ai-readiness-and-monitors.md §1):
 * can AI answer engines and agents read the site, and which ones does it let
 * in? HTTP only, after the crawl:
 *
 * - `/llms.txt` exists and follows the proposal (an H1 title, then markdown
 *   links to the pages that matter), and its same-site links answer;
 * - robots.txt, read for each named AI crawler: one info finding with the
 *   allow or block matrix for the home page (the policy is the owner's
 *   choice; Webtrax never says which is right), and a finding when a vendor's
 *   search crawler and its user-triggered agent are treated differently,
 *   which is rarely what was meant;
 * - JSON-LD that does not parse (agents and search engines skip it), and a
 *   site with no structured data on any page.
 *
 * Webtrax never probes with another crawler's user agent: the matrix comes
 * from robots.txt alone.
 */
import { parseRobots, type CheckSuite, type SuiteCtx } from '@webtrax/engine'
import { normaliseUrl, type RuleMeta } from '@webtrax/protocol'

const rule = (id: string, severity: RuleMeta['severity'], title: string, why: string, fix: string): RuleMeta => ({
  id, suite: 'ai_readiness', title, version: 1, severity, why, fix, docs_slug: id.replace(/[._]/g, '-'), tags: ['ai'],
})

export const AI_RULES = [
  rule('ai_readiness.llms_txt.missing', 'low', 'No llms.txt', 'AI assistants and agents look for /llms.txt: a short markdown guide to a site\'s most useful pages. Without it they guess from navigation and boilerplate.', 'Publish /llms.txt as plain text: a "# Site name" line, a one-line "> summary", then "## Sections" listing "- [Page](https://…): what it is" for your key pages.'),
  rule('ai_readiness.llms_txt.invalid', 'low', 'llms.txt does not follow the format', 'Tools that read llms.txt expect a markdown H1 title and links to pages; a file that is HTML, has no title, has no links, or links to missing pages misleads them.', 'Start the file with "# Site name", list your key pages as markdown links, serve it as text/plain, and fix or remove links that do not answer.'),
  rule('ai_readiness.crawlers.policy', 'info', 'AI crawler access (from robots.txt)', 'Which AI systems may read your site is your choice. This lists what robots.txt currently allows for each known AI crawler, so you can check it matches your intent.', 'Nothing to fix unless the table is not what you meant. Change robots.txt groups by user agent (for example "User-agent: GPTBot").'),
  rule('ai_readiness.crawlers.inconsistent', 'medium', 'AI search and AI agent are treated differently', 'Each vendor has a search crawler (it builds the index answers come from) and a user-triggered agent (it fetches a page when someone asks about it). Allowing one but blocking the other is usually an accident: the site can be cited but not opened, or opened but never found.', 'Decide one policy per vendor and give both of its user agents the same rule in robots.txt.'),
  rule('ai_readiness.schema.invalid', 'low', 'Structured data does not parse', 'JSON-LD that is not valid JSON is ignored by search engines and AI systems, so the facts it was meant to state (organisation, product, prices, articles) are lost.', 'Fix the JSON in the <script type="application/ld+json"> block (a trailing comma or an unescaped quote is the usual cause) and check it with a structured data validator.'),
  rule('ai_readiness.schema.none', 'low', 'No structured data on any page', 'JSON-LD states facts (who you are, what you sell, prices, articles) in a form search engines and AI systems read reliably. Without it they infer them from prose and can get them wrong.', 'Add JSON-LD: at least Organization (or WebSite) on the home page, and Product, Article or FAQPage where they fit.'),
] satisfies RuleMeta[]

/** Named AI crawlers by vendor, from their published documentation. */
export const AI_CRAWLERS = [
  'GPTBot', 'OAI-SearchBot', 'ChatGPT-User', 'ClaudeBot', 'Claude-SearchBot', 'Claude-User', 'anthropic-ai', 'PerplexityBot', 'Perplexity-User',
  'Google-Extended', 'Applebot-Extended', 'CCBot', 'Bytespider', 'meta-externalagent', 'Amazonbot',
] as const

/** A vendor's search crawler and its user-triggered agent: the same policy is almost always meant for both. */
export const CRAWLER_PAIRS = [
  { vendor: 'OpenAI', search: 'OAI-SearchBot', agent: 'ChatGPT-User' },
  { vendor: 'Anthropic', search: 'Claude-SearchBot', agent: 'Claude-User' },
  { vendor: 'Perplexity', search: 'PerplexityBot', agent: 'Perplexity-User' },
] as const

export interface LlmsTxtCheck { problems: string[]; links: string[] }

/** Checks an llms.txt body against the proposal (llmstxt.org): an H1 title first, then markdown links. */
export function checkLlmsTxt(body: string, base: string): LlmsTxtCheck {
  const problems: string[] = []
  const text = body.replace(/^\uFEFF/, '')
  const first = text.split(/\r?\n/).find((l) => l.trim() !== '')?.trim() ?? ''
  if (/^<(!doctype|html|head|body)\b/i.test(first)) return { problems: ['served as an HTML page, not markdown'], links: [] }
  if (!/^# \S/.test(first)) problems.push('does not start with a "# Title" line')
  const links = [...text.matchAll(/\[[^\]\n]*\]\(([^)\s]+)\)/g)].flatMap((m) => {
    try {
      return [new URL(m[1]!, base).href]
    } catch {
      return []
    }
  })
  if (!links.length) problems.push('lists no pages as markdown links')
  return { problems, links: [...new Set(links)] }
}

const MAX_LINK_CHECKS = 20
/** Per crawl (one context per suite per crawl): 200 HTML pages seen, and how many had JSON-LD. */
const seen = new WeakMap<SuiteCtx, { pages: number; withData: number }>()
const looksHtml = (contentType: string | undefined, body: string) => /\bhtml\b/i.test(contentType ?? '') || /^\s*<(!doctype|html)\b/i.test(body)

export const aiSuite: CheckSuite = {
  id: 'ai_readiness',
  version: '1.0.0',
  requires: ['http'],
  rules: AI_RULES,

  async onPage(ctx, page) {
    if (page.outcome.status !== 200) return
    const { $ } = page.doc
    const blocks = $('script[type="application/ld+json" i]')
    const count = seen.get(ctx) ?? { pages: 0, withData: 0 }
    count.pages += 1
    if (blocks.length) count.withData += 1
    seen.set(ctx, count)
    let bad = 0
    let firstError = ''
    blocks.each((_, el) => {
      const raw = $(el).text().trim()
      if (!raw) return
      try {
        JSON.parse(raw)
      } catch (e) {
        bad += 1
        firstError ||= (e instanceof Error ? e.message : String(e)).slice(0, 200)
      }
    })
    if (bad) await ctx.emit({ rule_id: 'ai_readiness.schema.invalid', url: page.url, evidence: { blocks: bad, error: firstError } })
  },

  async onSite(ctx, site) {
    const home = `${site.origin}/`

    // llms.txt
    const llmsUrl = `${site.origin}/llms.txt`
    const llms = await ctx.text(llmsUrl, 512 * 1024)
    const body = llms.body ?? ''
    const sameFile = (llms.finalUrl || llmsUrl).replace(/\/$/, '') === llmsUrl
    if (llms.status === 200 && sameFile && body.trim() && !looksHtml(llms.contentType, body)) {
      const check = checkLlmsTxt(body, llmsUrl)
      const sameSite = check.links.filter((u) => u.startsWith(`${site.origin}/`)).slice(0, MAX_LINK_CHECKS)
      const broken: { url: string; status: number | null }[] = []
      for (const u of sameSite) {
        const known = site.pages.get(normaliseUrl(u) ?? u)
        const status = known ? known.status : (await ctx.request(u)).status
        if (status === null || status >= 400) broken.push({ url: u, status })
      }
      if (broken.length) check.problems.push(`${broken.length} linked page${broken.length === 1 ? ' does' : 's do'} not answer`)
      if (check.problems.length) await ctx.emit({ rule_id: 'ai_readiness.llms_txt.invalid', url: llmsUrl, evidence: { problems: check.problems, links: check.links.length, ...(broken.length ? { broken: broken.slice(0, 10) } : {}) } })
    } else if (llms.status === 200 && sameFile && looksHtml(llms.contentType, body)) {
      // Many hosts answer every path with the app's HTML: that is not an llms.txt.
      await ctx.emit({ rule_id: 'ai_readiness.llms_txt.invalid', url: llmsUrl, evidence: { problems: ['served as an HTML page, not markdown'], content_type: llms.contentType ?? null } })
    } else if (llms.error === undefined && llms.status !== null && llms.status < 500 && llms.status !== 429) {
      await ctx.emit({ rule_id: 'ai_readiness.llms_txt.missing', url: null, evidence: { status: llms.status, ...(sameFile ? {} : { redirected_to: llms.finalUrl }) } })
    }

    // Structured data anywhere?
    const count = seen.get(ctx)
    if (count && count.pages > 0 && count.withData === 0) {
      await ctx.emit({ rule_id: 'ai_readiness.schema.none', url: null, evidence: { pages_checked: count.pages } })
    }

    // robots.txt, read for each AI crawler.
    const robotsUrl = `${site.origin}/robots.txt`
    const robots = await ctx.text(robotsUrl)
    if (robots.error !== undefined || robots.status === null || robots.status >= 500) return
    const robotsText = robots.status < 400 && !looksHtml(robots.contentType, robots.body ?? '') ? (robots.body ?? '') : ''
    const allowed = Object.fromEntries(AI_CRAWLERS.map((bot) => [bot, parseRobots(robotsUrl, robotsText, bot).isAllowed(home)])) as Record<(typeof AI_CRAWLERS)[number], boolean>
    const blocked = AI_CRAWLERS.filter((b) => !allowed[b])
    await ctx.emit({
      rule_id: 'ai_readiness.crawlers.policy', url: robotsUrl,
      // The matrix is part of the identity: a changed policy is a new finding.
      evidence_key: blocked.join(',') || 'all-allowed',
      title: blocked.length === 0 ? 'robots.txt allows every known AI crawler' : blocked.length === AI_CRAWLERS.length ? 'robots.txt blocks every known AI crawler' : `robots.txt blocks ${blocked.length} of ${AI_CRAWLERS.length} known AI crawlers`,
      evidence: { robots_txt: robotsText ? 'found' : 'none', home, crawlers: Object.fromEntries(AI_CRAWLERS.map((b) => [b, allowed[b] ? 'allowed' : 'blocked'])) },
    })
    for (const p of CRAWLER_PAIRS) {
      if (allowed[p.search] === allowed[p.agent]) continue
      await ctx.emit({
        rule_id: 'ai_readiness.crawlers.inconsistent', url: robotsUrl, evidence_key: p.vendor,
        title: `${p.vendor}: ${allowed[p.search] ? `search allowed, agent blocked` : `agent allowed, search blocked`}`,
        evidence: { vendor: p.vendor, [p.search]: allowed[p.search] ? 'allowed' : 'blocked', [p.agent]: allowed[p.agent] ? 'allowed' : 'blocked' },
      })
    }

  },
}

export default aiSuite
