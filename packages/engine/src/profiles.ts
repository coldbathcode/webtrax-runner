/**
 * Browser profiles (C06.10; plan/06-check-suites/browsers-and-devices.md):
 * what the browser stage loads a page as. Chromium in both; neither is a
 * real device, and the wording in reports says so.
 *
 * - `desktop`: laptop size, full speed, a fast line. As before profiles.
 * - `phone`: a mid-range Android phone on Chrome: a small touch viewport,
 *   the CPU four times slower, and a slow 4G line (shaped in the egress
 *   proxy, so later engines get the same line).
 *
 * - `webkit-desktop`, `webkit-phone`, `firefox-desktop` (C06.10 slice d):
 *   Safari's engine at Mac and iPhone sizes, and Firefox, at full speed on a
 *   fast line (only Chromium can slow the CPU, so engines are compared at
 *   desktop speed). For what differs between engines; never in the score.
 *
 * The user agent stays honest: the phone profile sends Chrome for Android's
 * string with the Webtrax token appended, as search engines' phone crawlers
 * do. robots.txt is still read as Webtrax.
 */
import type { BrowserEngine } from '@webtrax/net-proxy'
import { BOT_INFO_URL, BOT_PRODUCT_TOKEN, BOT_VERSION, type BrowserProfileId } from '@webtrax/protocol'

export type { BrowserEngine }

export interface BrowserProfile {
  id: BrowserProfileId
  engine: BrowserEngine
  /** What a report calls it. */
  label: string
  form: 'desktop' | 'phone'
  viewport: { width: number; height: number }
  pixelRatio: number
  touch: boolean
  /** How many times slower the CPU runs (Chromium's own throttle). */
  cpuSlowdown?: number
  /** The line, shaped by the egress proxy. */
  network?: { down_kbps: number; up_kbps: number; latency_ms: number }
}

export const PROFILES: Record<BrowserProfileId, BrowserProfile> = {
  desktop: { id: 'desktop', engine: 'chromium', label: 'Desktop', form: 'desktop', viewport: { width: 1350, height: 940 }, pixelRatio: 1, touch: false },
  phone: {
    id: 'phone', engine: 'chromium', label: 'Phone', form: 'phone', viewport: { width: 412, height: 915 }, pixelRatio: 2.625, touch: true,
    cpuSlowdown: 4, network: { down_kbps: 1600, up_kbps: 750, latency_ms: 150 },
  },
  'webkit-desktop': { id: 'webkit-desktop', engine: 'webkit', label: 'WebKit (Safari\'s engine), desktop size', form: 'desktop', viewport: { width: 1350, height: 940 }, pixelRatio: 1, touch: false },
  'webkit-phone': { id: 'webkit-phone', engine: 'webkit', label: 'WebKit (Safari\'s engine), phone size', form: 'phone', viewport: { width: 393, height: 852 }, pixelRatio: 3, touch: true },
  'firefox-desktop': { id: 'firefox-desktop', engine: 'firefox', label: 'Firefox, desktop size', form: 'desktop', viewport: { width: 1350, height: 940 }, pixelRatio: 1, touch: false },
}

const TOKEN = () => `(compatible; ${BOT_PRODUCT_TOKEN}/${BOT_VERSION}; +${BOT_INFO_URL})`
/** Safari on a Mac's user agent (webtrax.dev/bot lists these strings: change both together) at this WebKit's version, with the Webtrax token. */
export function webkitDesktopUserAgent(webkitVersion: string): string {
  const v = /^(\d+(\.\d+)?)/.exec(webkitVersion)?.[1] ?? '26.0'
  return `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/${v} Safari/605.1.15 ${TOKEN()}`
}
/** Safari on an iPhone's user agent at this WebKit's version, with the Webtrax token. */
export function webkitPhoneUserAgent(webkitVersion: string): string {
  const v = /^(\d+(\.\d+)?)/.exec(webkitVersion)?.[1] ?? '26.0'
  return `Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/${v} Mobile/15E148 Safari/604.1 ${TOKEN()}`
}
/** Firefox on a laptop's user agent at this Firefox's major version, with the Webtrax token. */
export function firefoxUserAgent(firefoxVersion: string): string {
  const major = /^(\d+)/.exec(firefoxVersion)?.[1] ?? '144'
  return `Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:${major}.0) Gecko/20100101 Firefox/${major}.0 ${TOKEN()}`
}

/**
 * The user agent a profile's browser sends: the spec's own when it sets one
 * (sent as it is), else the bot's for Chromium's desktop (as before), else
 * that browser's user agent with the Webtrax token.
 */
export function profileUserAgent(profile: BrowserProfile, browserVersion: string, specUserAgent: string | undefined, botUserAgent: string): string {
  if (specUserAgent) return specUserAgent
  switch (profile.id) {
    case 'phone': return phoneUserAgent(browserVersion)
    case 'webkit-desktop': return webkitDesktopUserAgent(browserVersion)
    case 'webkit-phone': return webkitPhoneUserAgent(browserVersion)
    case 'firefox-desktop': return firefoxUserAgent(browserVersion)
    default: return botUserAgent
  }
}

/** Chrome for Android's user agent at this Chromium's major version, with the Webtrax token. */
export function phoneUserAgent(chromiumVersion: string): string {
  const major = /^(\d+)/.exec(chromiumVersion)?.[1] ?? '140'
  return `Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Mobile Safari/537.36 (compatible; ${BOT_PRODUCT_TOKEN}/${BOT_VERSION}; +${BOT_INFO_URL})`
}

/** Chrome's major version in user agents sent without a browser (HTTP checks by device). Bump with Playwright. */
export const CHROME_MAJOR = '143'

/** Chrome on a laptop's user agent, with the Webtrax token. */
export function desktopUserAgent(chromiumVersion: string = CHROME_MAJOR): string {
  const major = /^(\d+)/.exec(chromiumVersion)?.[1] ?? CHROME_MAJOR
  return `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36 (compatible; ${BOT_PRODUCT_TOKEN}/${BOT_VERSION}; +${BOT_INFO_URL})`
}

/** The user agent a device's browser sends, for HTTP checks that ask "does a phone get the same answer?". */
export const deviceUserAgent = (device: 'phone' | 'desktop'): string => (device === 'phone' ? phoneUserAgent(CHROME_MAJOR) : desktopUserAgent())
