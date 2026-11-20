import { describe, expect, it } from 'vitest'
import { gradeFor, healthScore, SCORE_BREADTH, SCORE_K, SCORE_SEVERITY_WEIGHT, SCORE_SUITE_WEIGHT, SCORE_VERSION, type ScoreFinding } from '../src/score'
import { SUITES } from '../src/enums'

const f = (rule_id: string, suite: string, severity: ScoreFinding['severity'], url: string | null = 'https://site.example/'): ScoreFinding => ({ rule_id, suite, severity, url })
const ALL = ['links', 'security', 'seo', 'ai_readiness', 'a11y', 'performance']

describe('health score v2', () => {
  it('is 100 with nothing to fix, and null when no scored suite ran', () => {
    expect(healthScore({ findings: [], pages: 40, suites: ALL })).toMatchObject({ version: SCORE_VERSION, score: 100, grade: 'A' })
    expect(healthScore({ findings: [f('x', 'links', 'high')], pages: 40, suites: [] })).toEqual({ version: 2, score: null, grade: null, suites: [] })
    expect(healthScore({ findings: [], pages: 40, suites: ['monitor'] }).score).toBeNull()
  })

  it('scores a suite as 100 × exp(−penalty / k) to one decimal, and averages by suite weight', () => {
    // One site-wide medium in security: penalty 2. Links is clean.
    const r = healthScore({ findings: [f('security.hsts', 'security', 'medium', null)], pages: 40, suites: ['links', 'security'] })
    const security = Math.round(1000 * Math.exp(-2 / SCORE_K)) / 10
    expect(security).toBe(84.6)
    expect(r.suites).toEqual([
      { suite: 'links', score: 100, penalty: 0, weight: 25, rules: 0 },
      { suite: 'security', score: 84.6, penalty: 2, weight: 20, rules: 1 },
    ])
    // (25 × 100 + 20 × 84.6) / 45 = 93.16
    expect(r).toMatchObject({ score: 93, grade: 'A' })
  })

  it('scales a rule by how much of the site it touches: a tenth of the pages counts in full', () => {
    const links = (places: number, pages: number) => healthScore({ findings: Array.from({ length: places }, (_, i) => f('links.broken', 'links', 'high', `https://site.example/${i}`)), pages, suites: ['links'] }).suites[0]!.penalty
    expect(links(1, 200)).toBe(0.25) // 5 × 10 × 1/200
    expect(links(10, 200)).toBe(2.5)
    expect(links(20, 200)).toBe(5)
    expect(links(150, 200)).toBe(5) // never more than the rule's weight
    expect(links(1, 4)).toBe(5)
    // A finding about the whole site (no URL) counts in full whatever the size.
    expect(healthScore({ findings: [f('ai_readiness.llms_txt.missing', 'ai_readiness', 'low', null)], pages: 5000, suites: ['ai_readiness'] }).suites[0]!.penalty).toBe(0.5)
  })

  it('counts each rule once per severity, never info, and only suites that ran', () => {
    const findings = [
      f('a11y.image_alt', 'a11y', 'high', 'https://site.example/a'), f('a11y.image_alt', 'a11y', 'high', 'https://site.example/b'),
      f('a11y.image_alt', 'a11y', 'low', 'https://site.example/c'),
      f('ai_readiness.crawlers.policy', 'ai_readiness', 'info', null),
      f('seo.title.missing', 'seo', 'critical', null),
    ]
    const r = healthScore({ findings, pages: 20, suites: ['a11y', 'ai_readiness'] })
    // a11y: 5 × min(1, 10 × 2/20) + 0.5 × min(1, 10 × 1/20) = 5.25; seo did not run, so its critical is not counted.
    expect(r.suites).toEqual([
      { suite: 'a11y', score: 64.6, penalty: 5.25, weight: 15, rules: 2 },
      { suite: 'ai_readiness', score: 100, penalty: 0, weight: 5, rules: 1 },
    ])
    expect(r.score).toBe(73) // (15 × 64.6 + 5 × 100) / 20 = 73.45
    expect(r.grade).toBe('C')
  })

  it('does not depend on the order of findings or suites, and survives odd page counts', () => {
    const findings = [f('links.broken', 'links', 'high', 'https://site.example/1'), f('seo.title.missing', 'seo', 'medium', 'https://site.example/2'), f('security.hsts', 'security', 'medium', null)]
    const a = healthScore({ findings, pages: 30, suites: ALL })
    const b = healthScore({ findings: [...findings].reverse(), pages: 30, suites: [...ALL].reverse() })
    expect(b).toEqual(a)
    expect(a.suites.map((s) => s.suite)).toEqual(['links', 'performance', 'security', 'seo', 'a11y', 'ai_readiness'])
    for (const pages of [0, -3, Number.NaN, 0.4]) expect(healthScore({ findings, pages, suites: ALL }).score).toBe(healthScore({ findings, pages: 1, suites: ALL }).score)
  })

  it('never goes below 0 or above 100, and grades at 90, 80, 70 and 60', () => {
    const bad = SUITES.flatMap((s) => Array.from({ length: 30 }, (_, i) => f(`${s}.rule${i}`, s, 'critical', null)))
    expect(healthScore({ findings: bad, pages: 10, suites: [...SUITES] })).toMatchObject({ score: 0, grade: 'F' })
    expect([100, 90, 89, 80, 79, 70, 69, 60, 59, 0].map(gradeFor)).toEqual(['A', 'A', 'B', 'B', 'C', 'C', 'D', 'D', 'F', 'F'])
  })

  it('weights: links 25, performance 20, security 20, seo 15, a11y 15, content 5, ai_readiness 5; monitor is not scored', () => {
    expect(SCORE_SUITE_WEIGHT).toEqual({ links: 25, performance: 20, security: 20, seo: 15, a11y: 15, content: 5, ai_readiness: 5 })
    expect(Object.values(SCORE_SUITE_WEIGHT).reduce((a, b) => a + b, 0)).toBe(105)
    // Published in docs /health-score/: changing any of these needs a new SCORE_VERSION and the page updated.
    expect({ k: SCORE_K, breadth: SCORE_BREADTH, weights: SCORE_SEVERITY_WEIGHT, version: SCORE_VERSION }).toEqual({ k: 12, breadth: 10, weights: { critical: 10, high: 5, medium: 2, low: 0.5, info: 0 }, version: 2 })
  })

  it('judges a browser suite against the pages it checked, not the whole crawl', () => {
    const slow = [f('performance.lcp.slow', 'performance', 'medium', 'https://site.example/a')]
    // One slow page of the 10 measured is a tenth of them: the full weight, 2. Against all 300 crawled pages it was 0.0667.
    expect(healthScore({ findings: slow, pages: 300, suites: [{ id: 'performance', pages: { desktop: 10 } }] }).suites[0]).toMatchObject({ penalty: 2, score: 84.6 })
    expect(healthScore({ findings: slow, pages: 300, suites: ['performance'] }).suites[0]).toMatchObject({ penalty: 0.0667, score: 99.4 })
    // Every other suite reads the whole crawl and is scored as before, whatever a summary says it looked at in a browser.
    expect(healthScore({ findings: [f('links.broken', 'links', 'high')], pages: 300, suites: [{ id: 'links' }] }).suites[0]!.penalty).toBe(0.1667)
    expect(healthScore({ findings: [f('ai_readiness.schema.invalid', 'ai_readiness', 'low')], pages: 300, suites: [{ id: 'ai_readiness', pages: { desktop: 10 } }] }).suites[0]!.penalty).toBe(0.0167)
  })

  it('scores speed and accessibility once per device and takes the mean; other suites once', () => {
    const findings: ScoreFinding[] = [
      // Slow on both, worse on the phone; one layout problem only the phone has; one desktop-only.
      { ...f('performance.lcp.slow', 'performance', 'high', 'https://site.example/'), by_profile: { desktop: 'medium', phone: 'high' } },
      { ...f('performance.cls.high', 'performance', 'low', 'https://site.example/'), by_profile: { phone: 'low' } },
      { ...f('performance.page_weight', 'performance', 'low', 'https://site.example/b'), by_profile: { desktop: 'low' } },
      { ...f('links.broken', 'links', 'high', 'https://site.example/x'), by_profile: { phone: 'high' } },
    ]
    const r = healthScore({ findings, pages: 40, suites: ['links', { id: 'performance', pages: { desktop: 10, phone: 1 } }] })
    // Desktop: medium 2 + low 0.5, each on 1 of 10 pages (full weight) = 2.5 → 81.2. Phone: high 5 + low 0.5 on its one page = 5.5 → 63.2.
    expect(r.suites.find((s) => s.suite === 'performance')).toEqual({ suite: 'performance', score: 72.2, penalty: 4, weight: 20, rules: 3, devices: { desktop: 81.2, phone: 63.2 } })
    // Links is not a per-device suite: its finding counts once, whatever profile saw it. 5 × 10 × 1/40 = 1.25 → 90.1.
    expect(r.suites.find((s) => s.suite === 'links')).toEqual({ suite: 'links', score: 90.1, penalty: 1.25, weight: 25, rules: 1 })
    // (25 × 90.1 + 20 × 72.2) / 45 = 82.1
    expect(r).toMatchObject({ score: 82, grade: 'B' })
  })

  it('leaves out a suite that was asked for and never ran, instead of scoring it as clean', () => {
    const findings = [f('links.broken', 'links', 'high', null)]
    const ran = healthScore({ findings, pages: 10, suites: ['links', { id: 'a11y', pages: { desktop: 5 } }, { id: 'performance', pages: { desktop: 5 } }] })
    const skipped = healthScore({ findings, pages: 10, suites: ['links', { id: 'a11y', skipped: true }, { id: 'performance', skipped: true }] })
    expect(ran.suites.map((s) => s.suite)).toEqual(['links', 'performance', 'a11y'])
    expect(skipped.suites.map((s) => s.suite)).toEqual(['links'])
    // Two clean suites it never ran would have lifted the score from 66 to 86.
    expect([ran.score, skipped.score]).toEqual([86, 66])
  })

  it('with one device, or findings from before profiles, scores as a single measurement', () => {
    const findings = [f('a11y.image_alt', 'a11y', 'high', 'https://site.example/a')]
    const one = healthScore({ findings, pages: 50, suites: [{ id: 'a11y', pages: { desktop: 25 } }] })
    expect(one.suites[0]).toEqual({ suite: 'a11y', score: 84.6, penalty: 2, weight: 15, rules: 1 })
    // A finding without by_profile counts on every device that ran.
    const both = healthScore({ findings, pages: 50, suites: [{ id: 'a11y', pages: { desktop: 25, phone: 25 } }] })
    expect(both.suites[0]).toMatchObject({ score: 84.6, devices: { desktop: 84.6, phone: 84.6 } })
    // A device that measured no pages is not a clean result: it is left out.
    expect(healthScore({ findings, pages: 50, suites: [{ id: 'a11y', pages: { desktop: 25, phone: 0 } }] }).suites[0]!.devices).toBeUndefined()
  })
})
