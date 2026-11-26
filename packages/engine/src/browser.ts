/**
 * Launching Chromium for the browser stage (C05.10). playwright-core is
 * loaded only when a browser suite runs, so HTTP-only checks never touch it.
 * Chromium always goes through the egress proxy (@webtrax/net-proxy).
 * Playwright's own Chromium is preferred; the machine's Google Chrome is the
 * fallback; with neither, the browser suites fail with instructions and the
 * rest of the run carries on.
 */
import { browserLaunchOptions, type BrowserEngine } from '@webtrax/net-proxy'
import type { Browser } from 'playwright-core'

export class BrowserUnavailableError extends Error {
  constructor(cause: string) {
    super(`The accessibility and performance suites need Chromium. Install it with "npx playwright@1.57.0 install chromium", or install Google Chrome. (${cause})`)
    this.name = 'BrowserUnavailableError'
  }
}

export class EngineUnavailableError extends Error {
  constructor(engine: BrowserEngine, cause: string) {
    super(`Loading pages in ${engine === 'webkit' ? 'WebKit' : 'Firefox'} needs it installed: "npx playwright@1.57.0 install ${engine}". (${cause})`)
    this.name = 'EngineUnavailableError'
  }
}

/** Launches an engine behind the egress proxy (`browserLaunchOptions`). Chromium falls back to the machine's Google Chrome. */
export async function launchBrowser(proxyUrl: string, engine: BrowserEngine = 'chromium'): Promise<Browser> {
  const pw = await import('playwright-core')
  const options = browserLaunchOptions(engine, proxyUrl)
  if (engine !== 'chromium') {
    try {
      return await pw[engine].launch(options)
    } catch (error) {
      throw new EngineUnavailableError(engine, (error as Error).message.split('\n')[0] ?? 'launch failed')
    }
  }
  try {
    return await pw.chromium.launch(options)
  } catch (first) {
    try {
      return await pw.chromium.launch({ ...options, channel: 'chrome' })
    } catch {
      throw new BrowserUnavailableError((first as Error).message.split('\n')[0] ?? 'launch failed')
    }
  }
}
