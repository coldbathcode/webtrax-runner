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
 * The user agent stays honest: the phone profile sends Chrome for Android's
 * string with the Webtrax token appended, as search engines' phone crawlers
 * do. robots.txt is still read as Webtrax.
 */
import { BOT_INFO_URL, BOT_PRODUCT_TOKEN, BOT_VERSION, type BrowserProfileId } from '@webtrax/protocol'

export interface BrowserProfile {
  id: BrowserProfileId
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
  desktop: { id: 'desktop', label: 'Desktop', form: 'desktop', viewport: { width: 1350, height: 940 }, pixelRatio: 1, touch: false },
  phone: {
    id: 'phone', label: 'Phone', form: 'phone', viewport: { width: 412, height: 915 }, pixelRatio: 2.625, touch: true,
    cpuSlowdown: 4, network: { down_kbps: 1600, up_kbps: 750, latency_ms: 150 },
  },
}

/** Chrome for Android's user agent at this Chromium's major version, with the Webtrax token. */
export function phoneUserAgent(chromiumVersion: string): string {
  const major = /^(\d+)/.exec(chromiumVersion)?.[1] ?? '140'
  return `Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Mobile Safari/537.36 (compatible; ${BOT_PRODUCT_TOKEN}/${BOT_VERSION}; +${BOT_INFO_URL})`
}
