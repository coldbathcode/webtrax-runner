/**
 * Launching Chromium for the browser stage (C05.10). playwright-core is
 * loaded only when a browser suite runs, so HTTP-only checks never touch it.
 * Chromium always goes through the egress proxy (@webtrax/net-proxy).
 * Playwright's own Chromium is preferred; the machine's Google Chrome is the
 * fallback; with neither, the browser suites fail with instructions and the
 * rest of the run carries on.
 */
import { chromiumProxyArgs } from '@webtrax/net-proxy'
import type { Browser } from 'playwright-core'

export class BrowserUnavailableError extends Error {
  constructor(cause: string) {
    super(`The accessibility and performance suites need Chromium. Install it with "npx playwright@1.57.0 install chromium", or install Google Chrome. (${cause})`)
    this.name = 'BrowserUnavailableError'
  }
}

export async function launchBrowser(proxyUrl: string): Promise<Browser> {
  const { chromium } = await import('playwright-core')
  const args = chromiumProxyArgs(proxyUrl)
  try {
    return await chromium.launch({ args })
  } catch (first) {
    try {
      return await chromium.launch({ args, channel: 'chrome' })
    } catch {
      throw new BrowserUnavailableError((first as Error).message.split('\n')[0] ?? 'launch failed')
    }
  }
}
