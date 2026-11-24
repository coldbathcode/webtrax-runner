/**
 * Links as a visitor sees them (C06.10 slice c): for a page loaded in the
 * browser, every link with an http(s) address and whether a visitor can use
 * it at this profile's size: `visible`, `menu` (hidden until a menu toggle on
 * the page is opened: a hamburger button, a `<details>`, a checkbox menu) or
 * `hidden`. Links whose centre is under a fixed or sticky element at load
 * (a cookie banner, a chat widget, a sticky bar) say what covers them.
 *
 * Read after the suites and the trace, because opening menus changes the
 * page. A toggle that navigates away ends the reading with what it had.
 */
import type { Page } from 'playwright-core'
import { normaliseUrl, type BrowserProfileId } from '@webtrax/protocol'

export type LinkReach = 'visible' | 'menu' | 'hidden'
export interface RenderedLink { url: string; reach: LinkReach; text?: string; covered_by?: string }
export interface RenderedLinks { url: string; profile: BrowserProfileId; links: RenderedLink[]; menus_opened: number }

export const RENDERED_LIMITS = { links: 1_000, toggles: 6, text: 80 } as const

type Seen = { href: string; visible: boolean; text: string; covered: string | null }

/** Runs in the page. No imports and no closures: Playwright sends its source. */
const READ_LINKS = (limits: { links: number; text: number }): Seen[] => {
  type El = { getBoundingClientRect(): { left: number; right: number; top: number; bottom: number; width: number; height: number }; checkVisibility?(o: object): boolean; contains(o: unknown): boolean; parentElement: El | null; tagName: string; id: string; className: unknown; getAttribute(n: string): string | null; closest(s: string): El | null; textContent: string | null; href?: string }
  const g = globalThis as unknown as {
    document: { querySelectorAll(s: string): ArrayLike<El>; elementFromPoint(x: number, y: number): El | null; documentElement: { scrollWidth: number; clientWidth: number } }
    innerWidth: number; innerHeight: number; getComputedStyle(e: El): { position: string; visibility: string; display: string }
  }
  const describe = (e: El): string => {
    const cls = typeof e.className === 'string' ? e.className.trim().split(/\s+/).filter(Boolean).slice(0, 2).map((c) => `.${c}`).join('') : ''
    return `${e.tagName.toLowerCase()}${e.id ? `#${e.id}` : ''}${cls}`.slice(0, 80)
  }
  /** The nearest fixed or sticky element at or above `e`, or null. */
  const pinned = (e: El | null): El | null => {
    for (let x = e; x; x = x.parentElement) { const p = g.getComputedStyle(x).position; if (p === 'fixed' || p === 'sticky') return x }
    return null
  }
  const width = Math.max(g.document.documentElement.scrollWidth, g.innerWidth)
  const out: Seen[] = []
  const anchors = g.document.querySelectorAll('a[href]')
  for (let i = 0; i < anchors.length && out.length < limits.links; i++) {
    const a = anchors[i]!
    const href = a.href ?? ''
    if (!/^https?:/i.test(href)) continue
    const r = a.getBoundingClientRect()
    const shown = a.checkVisibility ? a.checkVisibility({ opacityProperty: true, visibilityProperty: true, contentVisibilityAuto: true }) : g.getComputedStyle(a).visibility !== 'hidden'
    // Skip links and screen-reader-only links are not what a visitor taps: off to the side, or a pixel wide.
    const visible = shown && r.width > 1 && r.height > 1 && r.right > 0 && r.left < width
    let covered: string | null = null
    if (visible) {
      const x = r.left + r.width / 2
      const y = r.top + r.height / 2
      if (x >= 0 && y >= 0 && x < g.innerWidth && y < g.innerHeight) {
        const hit = g.document.elementFromPoint(x, y)
        if (hit && hit !== a && !a.contains(hit) && !hit.contains(a)) {
          const cover = pinned(hit)
          // A link inside the fixed element itself (a sticky header's own links) is not covered by it.
          if (cover && !cover.contains(a)) covered = describe(cover)
        }
      }
    }
    out.push({ href, visible, text: (a.textContent ?? a.getAttribute('aria-label') ?? '').replace(/\s+/g, ' ').trim().slice(0, limits.text), covered })
  }
  return out
}

/** Runs in the page: marks menu toggles a visitor can see, so the runner can open them one at a time. */
const MARK_TOGGLES = (max: number): number => {
  type El = { getBoundingClientRect(): { width: number; height: number }; checkVisibility?(o: object): boolean; getAttribute(n: string): string | null; setAttribute(n: string, v: string): void; textContent: string | null; closest(s: string): unknown; tagName: string; open?: boolean }
  const g = globalThis as unknown as { document: { querySelectorAll(s: string): ArrayLike<El>; getElementById(id: string): El | null } }
  const seen = new Set<El>()
  const picked: El[] = []
  const ok = (e: El) => { const r = e.getBoundingClientRect(); return r.width > 1 && r.height > 1 && (!e.checkVisibility || e.checkVisibility({ opacityProperty: true, visibilityProperty: true })) }
  const add = (e: El | null) => { if (e && !seen.has(e) && picked.length < max && ok(e)) { seen.add(e); picked.push(e) } }
  const all = (s: string) => Array.from(g.document.querySelectorAll(s))
  // A menu button says it opens something; a disclosure is closed; a checkbox menu has a label to tap.
  for (const e of all('button[aria-expanded="false"], [role="button"][aria-expanded="false"], button[aria-controls], [role="button"][aria-controls]')) add(e)
  for (const e of all('details:not([open]) > summary')) add(e)
  for (const e of all('[aria-haspopup="true"], [aria-haspopup="menu"], [class*="hamburger" i], [class*="burger" i], [class*="menu-toggle" i], [class*="nav-toggle" i], [id*="menu-toggle" i], [id*="nav-toggle" i]')) add(e)
  for (const e of all('button, [role="button"]')) if (/\b(menu|navigation|nav)\b|☰|≡/i.test(`${e.getAttribute('aria-label') ?? ''} ${e.textContent ?? ''} ${e.getAttribute('title') ?? ''}`)) add(e)
  for (const l of all('label[for]')) {
    const target = g.document.getElementById(l.getAttribute('for') ?? '')
    if (target && target.tagName === 'INPUT' && target.getAttribute('type') === 'checkbox' && l.closest('header, nav, [role="navigation"]')) add(l)
  }
  picked.forEach((e, i) => e.setAttribute('data-webtrax-toggle', String(i)))
  return picked.length
}

const CLICK_TOGGLE = (i: number): boolean => {
  const g = globalThis as unknown as { document: { querySelector(s: string): { click(): void } | null } }
  const e = g.document.querySelector(`[data-webtrax-toggle="${i}"]`)
  if (!e) return false
  e.click()
  return true
}

const settle = (page: Page, ms: number) => page.waitForTimeout(ms).catch(() => {})

/**
 * The page's links at this profile. Visible at load first; then each menu
 * toggle is opened in turn (at most `RENDERED_LIMITS.toggles`) and links that
 * became visible are `menu`. Null when the page could not be read.
 */
export async function readRenderedLinks(page: Page, url: string, profile: BrowserProfileId): Promise<RenderedLinks | null> {
  const limits = { links: RENDERED_LIMITS.links, text: RENDERED_LIMITS.text }
  const first = await page.evaluate(READ_LINKS, limits).catch(() => null)
  if (!first) return null
  const byUrl = new Map<string, RenderedLink>()
  for (const s of first) {
    const u = normaliseUrl(s.href)
    if (!u) continue
    const had = byUrl.get(u)
    // A link counts as reachable when any of its anchors is: a menu and a footer both carrying it is one link.
    if (!had) byUrl.set(u, { url: u, reach: s.visible ? 'visible' : 'hidden', ...(s.text ? { text: s.text } : {}), ...(s.covered ? { covered_by: s.covered } : {}) })
    else if (s.visible && had.reach !== 'visible') { had.reach = 'visible'; if (s.covered) had.covered_by = s.covered; else delete had.covered_by }
    else if (s.visible && had.covered_by && !s.covered) delete had.covered_by
  }
  let opened = 0
  if ([...byUrl.values()].some((l) => l.reach === 'hidden')) {
    const start = page.url()
    const toggles = await page.evaluate(MARK_TOGGLES, RENDERED_LIMITS.toggles).catch(() => 0)
    for (let i = 0; i < toggles; i++) {
      const clicked = await page.evaluate(CLICK_TOGGLE, i).catch(() => false)
      if (!clicked) continue
      // Menus usually animate open.
      await settle(page, 350)
      if (page.url() !== start) break
      const after = await page.evaluate(READ_LINKS, limits).catch(() => null)
      if (!after) break
      opened += 1
      for (const s of after) {
        const u = s.visible ? normaliseUrl(s.href) : null
        const had = u ? byUrl.get(u) : undefined
        if (had && had.reach === 'hidden') had.reach = 'menu'
      }
      if (![...byUrl.values()].some((l) => l.reach === 'hidden')) break
    }
  }
  return { url, profile, links: [...byUrl.values()], menus_opened: opened }
}
