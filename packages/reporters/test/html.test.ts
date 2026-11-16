// The HTML report must be accessible (WCAG 2.2 AA via axe, the engine behind
// Lighthouse's accessibility score) in light and dark mode, with every
// finding expanded, and must load nothing from the network.
import { AxeBuilder } from '@axe-core/playwright'
import { chromium, type Browser } from 'playwright'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildReport, renderHtml } from '../src'
import { RECORDS, RULES } from './sample'

let browser: Browser
// A real browser plus axe takes longer than vitest's 5 s default on busy CI runners.
beforeAll(async () => { browser = await chromium.launch() }, 60_000)
afterAll(async () => { await browser?.close() })

const html = renderHtml(buildReport(RECORDS, RULES))

describe.each(['light', 'dark'] as const)('HTML report in %s mode', (colorScheme) => {
  it('has no axe violations (WCAG 2.2 AA), findings expanded', async () => {
    const context = await browser.newContext({ colorScheme })
    const page = await context.newPage()
    const requests: string[] = []
    page.on('request', (r) => { if (!r.url().startsWith('data:') && r.url() !== 'about:blank') requests.push(r.url()) })
    await page.setContent(html, { waitUntil: 'load' })
    await page.evaluate(() => document.querySelectorAll('details').forEach((d) => { d.open = true }))
    const result = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice']).analyze()
    expect(result.violations.map((v) => `${v.id}: ${v.nodes.length}`)).toEqual([])
    expect(requests).toEqual([])
    await context.close()
  }, 30_000)
})
