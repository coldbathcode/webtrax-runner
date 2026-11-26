/**
 * Performance suite (C05.10 / C06.2): lab measurements from one Chromium
 * load per sampled page (default 10): Largest Contentful Paint, cumulative
 * layout shift, time to first byte, first contentful paint, transferred
 * bytes and request count, recorded as metrics, with findings at the Core
 * Web Vitals thresholds. Measured through the runner's egress proxy on one
 * load, so treat values as indicative and compare runs, not single numbers.
 * Measured once per browser profile (C06.10): as a desktop, and as a phone
 * when the run asks for it.
 */
import type { CheckSuite } from '@webtrax/engine'
import type { RuleMeta, Severity } from '@webtrax/protocol'

const rule = (id: string, severity: Severity, title: string, why: string, fix: string): RuleMeta => ({
  id, suite: 'performance', title, version: 1, severity, why, fix, docs_slug: id.replace(/[._]/g, '-'), tags: [],
})

export const THRESHOLDS = {
  lcp: { poor: 4000, needsWork: 2500 },
  cls: { poor: 0.25, needsWork: 0.1 },
  ttfb: { poor: 1800, needsWork: 800 },
  weight: { poor: 6 * 1024 * 1024, needsWork: 3 * 1024 * 1024 },
} as const

export const PERFORMANCE_RULES = [
  rule('performance.lcp.slow', 'medium', 'Largest Contentful Paint is slow', 'LCP is when the main content appears; past 2.5 s visitors start to leave, and it is a Core Web Vital that affects search ranking.', 'Serve the main image or text faster: compress and size images, preload the LCP image, cut render-blocking CSS and JavaScript, and cache at the edge.'),
  rule('performance.cls.high', 'low', 'Layout shifts while the page loads', 'Content that jumps makes visitors misclick and lose their place; CLS is a Core Web Vital.', 'Give images, embeds and ads fixed dimensions, and avoid inserting content above what is already shown.'),
  rule('performance.ttfb.slow', 'low', 'The server is slow to respond', 'Every other timing waits for the first byte; a slow TTFB usually means no caching or a slow backend.', 'Cache pages at the edge or CDN, and profile the slow part of the server response.'),
  rule('performance.page_weight', 'low', 'The page downloads a lot of data', 'Heavy pages are slow on mobile networks and cost visitors data.', 'Compress and resize images, drop unused JavaScript and fonts, and lazy-load below-the-fold media.'),
] satisfies RuleMeta[]

interface Measured { ttfb: number; fcp: number | null; lcp: number | null; cls: number; bytes: number; requests: number; domContentLoaded: number }

/** Runs in the page after load: Navigation Timing, paint and LCP entries, layout shifts and resources. */
const MEASURE = async (): Promise<Measured> => {
  const nav = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined
  // Paint, LCP and layout shifts can arrive after load; buffered observers collect them for half a second.
  // LCP and layout-shift entries are never in the timeline's buffer (getEntriesByType gives none): only an observer sees them.
  const { fcp, lcp, cls } = await new Promise<{ fcp: number | null; lcp: number | null; cls: number }>((resolve) => {
    let fcpAt: number | null = performance.getEntriesByName('first-contentful-paint')[0]?.startTime ?? null
    let lcpAt: number | null = null
    let shift = 0
    try {
      new PerformanceObserver((list) => { for (const e of list.getEntries()) if (e.name === 'first-contentful-paint') fcpAt = e.startTime }).observe({ type: 'paint', buffered: true })
      new PerformanceObserver((list) => { for (const e of list.getEntries()) lcpAt = e.startTime }).observe({ type: 'largest-contentful-paint', buffered: true })
      new PerformanceObserver((list) => { for (const e of list.getEntries() as unknown as { value: number; hadRecentInput: boolean }[]) if (!e.hadRecentInput) shift += e.value }).observe({ type: 'layout-shift', buffered: true })
    } catch { /* unsupported */ }
    setTimeout(() => resolve({ fcp: fcpAt, lcp: lcpAt, cls: shift }), 500)
  })
  const resources = performance.getEntriesByType('resource') as PerformanceResourceTiming[]
  const bytes = (nav?.transferSize ?? 0) + resources.reduce((sum, r) => sum + (r.transferSize || 0), 0)
  return { ttfb: nav ? nav.responseStart - nav.startTime : 0, fcp, lcp, cls, bytes, requests: resources.length + 1, domContentLoaded: nav ? nav.domContentLoadedEventEnd - nav.startTime : 0 }
}

/** Findings for measured values, by threshold (exported for tests). */
export function assess(m: Measured): { rule_id: string; severity: Severity; evidence: Record<string, unknown> }[] {
  const out: { rule_id: string; severity: Severity; evidence: Record<string, unknown> }[] = []
  if (m.lcp !== null && m.lcp > THRESHOLDS.lcp.needsWork) out.push({ rule_id: 'performance.lcp.slow', severity: m.lcp > THRESHOLDS.lcp.poor ? 'high' : 'medium', evidence: { lcp_ms: Math.round(m.lcp), threshold_ms: THRESHOLDS.lcp.needsWork } })
  if (m.cls > THRESHOLDS.cls.needsWork) out.push({ rule_id: 'performance.cls.high', severity: m.cls > THRESHOLDS.cls.poor ? 'medium' : 'low', evidence: { cls: Math.round(m.cls * 1000) / 1000, threshold: THRESHOLDS.cls.needsWork } })
  if (m.ttfb > THRESHOLDS.ttfb.needsWork) out.push({ rule_id: 'performance.ttfb.slow', severity: m.ttfb > THRESHOLDS.ttfb.poor ? 'medium' : 'low', evidence: { ttfb_ms: Math.round(m.ttfb), threshold_ms: THRESHOLDS.ttfb.needsWork } })
  if (m.bytes > THRESHOLDS.weight.needsWork) out.push({ rule_id: 'performance.page_weight', severity: m.bytes > THRESHOLDS.weight.poor ? 'medium' : 'low', evidence: { bytes: m.bytes, requests: m.requests, threshold_bytes: THRESHOLDS.weight.needsWork } })
  return out
}

export const performanceSuite: CheckSuite = {
  id: 'performance',
  version: '1.0.0',
  requires: ['http', 'browser'],
  rules: PERFORMANCE_RULES,
  defaultSample: 10,
  // Speed depends on the device: measured as each browser profile (desktop, phone).
  everyProfile: true,

  async onBrowserPage(ctx, bp) {
    if (bp.status === null || bp.status >= 400) return
    // On a slow line fonts and images are still arriving at the load event: wait for them (five seconds
    // at most), or the page's weight is under-counted.
    await bp.page.waitForLoadState('networkidle', { timeout: 5_000 }).catch(() => {})
    const m = (await bp.page.evaluate(MEASURE)) as Measured
    await ctx.metric('ttfb_ms', Math.round(m.ttfb), 'ms', bp.url)
    if (m.fcp !== null) await ctx.metric('fcp_ms', Math.round(m.fcp), 'ms', bp.url)
    if (m.lcp !== null) await ctx.metric('lcp_ms', Math.round(m.lcp), 'ms', bp.url)
    await ctx.metric('cls', Math.round(m.cls * 1000) / 1000, 'score', bp.url)
    await ctx.metric('transfer_bytes', m.bytes, 'bytes', bp.url)
    await ctx.metric('requests', m.requests, 'count', bp.url)
    await ctx.metric('load_ms', Math.round(bp.loadMs), 'ms', bp.url)
    for (const f of assess(m)) {
      // Time to first byte on the phone profile is mostly the slow line's handshakes, not the server:
      // it is recorded as a metric, and only the desktop measurement can say the server is slow.
      if (f.rule_id === 'performance.ttfb.slow' && bp.profile !== 'desktop') continue
      await ctx.emit({ ...f, url: bp.url })
    }
  },
}

export default performanceSuite
