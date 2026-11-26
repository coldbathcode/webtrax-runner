/**
 * Per-host politeness (pipeline doc §2, OPS-08, COR-09, COR-12, V2-COR-12).
 *
 * One HostThrottle is shared by every job in a process, so two scans of the
 * same site do not double its load. Each host gets a minimum interval between
 * request starts. Slots are reserved synchronously before awaiting, so
 * concurrent callers queue up instead of all seeing the same "last request"
 * time and firing together (v1 COR-09).
 *
 * - **Fixed hosts** (every host by default): 1 / rps, or the host's robots.txt
 *   Crawl-delay if longer, times a penalty that doubles on every 429 (or 503
 *   with Retry-After) and halves again for each minute without one.
 * - **Adaptive hosts** (the scan's own site, when the spec allows more than
 *   its base rate, `limits.origin_max_rps`): the rate starts at the base and
 *   grows while the host answers well, the way TCP finds a link's speed:
 *   by half again each round (about a second of requests) until the first
 *   sign of trouble, then by one request a second per round, never past the
 *   maximum. A 429 halves it and holds it for 30 s. Answers that slow down
 *   against the host's own best (`observe`) stop the growth, and slowing badly
 *   cuts the rate by a quarter: the server is straining. Crawl-delay still wins.
 * - **Walls** (a firewall or bot challenge, `classify.ts` `botWall`): the host
 *   drops to its slowest rate and pauses, 15 s for the first, doubling to 2
 *   minutes. After `WALL_LIMIT` walls nothing more is sent to it: the caller
 *   reports what is left as could-not-verify, and stops if it is the site
 *   itself. Nothing tries to get around a wall.
 *
 * A host's state is forgotten after `IDLE_FORGET_MS` without a request, so one
 * bad scan does not slow every later scan of that host in a long-lived worker.
 */
export interface ThrottleClock {
  now(): number
  sleep(ms: number, signal?: AbortSignal): Promise<void>
}

export const realClock: ThrottleClock = {
  now: () => Date.now(),
  sleep: (ms, signal) =>
    new Promise((resolve) => {
      if (ms <= 0 || signal?.aborted) return resolve()
      const t = setTimeout(resolve, ms)
      signal?.addEventListener('abort', () => { clearTimeout(t); resolve() }, { once: true })
    }),
}

export const MAX_CRAWL_DELAY_SECONDS = 30
const MAX_PENALTY = 32
const PENALTY_HALF_LIFE_MS = 60_000
/** The slowest an adaptive host goes: one request every two seconds. */
export const MIN_ADAPTIVE_RPS = 0.5
const HOLD_AFTER_LIMIT_MS = 30_000
const HOLD_AFTER_STRAIN_MS = 5_000
/** Samples of a host's answer time before its best is trusted. */
const BASELINE_SAMPLES = 5
export const WALL_LIMIT = 3
const WALL_PAUSE_MS = 15_000
const MAX_WALL_PAUSE_MS = 120_000
export const IDLE_FORGET_MS = 10 * 60_000

interface Adaptive {
  rate: number
  /** The fastest it has gone. */
  peak: number
  max: number
  /** Below this the rate grows by half each round; above it, by one. Infinity until the first trouble. */
  threshold: number
  /** Good answers since the rate last changed. */
  streak: number
  /** Smoothed wire time, and the best it has been. */
  ewma?: number
  best?: number
  samples: number
  holdUntil: number
}

interface HostState {
  lastUsed: number
  nextSlot: number
  crawlDelayMs?: number
  penalty: number
  penaltyAt: number
  adaptive?: Adaptive
  walls: number
  pausedUntil: number
}

export type WallVerdict = 'pause' | 'stop'

export class HostThrottle {
  private readonly hosts = new Map<string, HostState>()

  constructor(private readonly clock: ThrottleClock = realClock) {}

  private state(host: string): HostState {
    const now = this.clock.now()
    let s = this.hosts.get(host)
    if (s && now - s.lastUsed > IDLE_FORGET_MS && s.nextSlot <= now) s = undefined
    if (!s) {
      s = { lastUsed: now, nextSlot: now, penalty: 1, penaltyAt: now, walls: 0, pausedUntil: 0 }
      this.hosts.set(host, s)
    }
    // The fixed penalty halves for each quiet minute.
    if (s.penalty > 1 && now - s.penaltyAt >= PENALTY_HALF_LIFE_MS) {
      const halvings = Math.floor((now - s.penaltyAt) / PENALTY_HALF_LIFE_MS)
      s.penalty = Math.max(1, s.penalty / 2 ** halvings)
      s.penaltyAt += halvings * PENALTY_HALF_LIFE_MS
    }
    return s
  }

  /** Honour a robots.txt Crawl-delay for `host`, capped at 30 s. */
  setCrawlDelay(host: string, seconds: number): void {
    if (Number.isFinite(seconds) && seconds > 0) this.state(host).crawlDelayMs = Math.min(seconds, MAX_CRAWL_DELAY_SECONDS) * 1000
  }

  /** Let `host` find its own speed, from `baseRps` up to `maxRps`. A host already adaptive keeps its rate. */
  adaptive(host: string, baseRps: number, maxRps: number): void {
    if (!(maxRps > baseRps)) return
    const s = this.state(host)
    if (s.adaptive) {
      s.adaptive.max = maxRps
      s.adaptive.rate = Math.min(s.adaptive.rate, maxRps)
    } else {
      s.adaptive = { rate: Math.max(baseRps, MIN_ADAPTIVE_RPS), peak: Math.max(baseRps, MIN_ADAPTIVE_RPS), max: maxRps, threshold: Infinity, streak: 0, samples: 0, holdUntil: 0 }
    }
  }

  /** The adaptive rate of `host` in requests per second, or null when it is fixed. */
  rate(host: string): number | null {
    return this.hosts.get(host)?.adaptive?.rate ?? null
  }

  /** The fastest an adaptive host has gone, or null when it is fixed. */
  peakRate(host: string): number | null {
    return this.hosts.get(host)?.adaptive?.peak ?? null
  }

  /** A good answer from `host` and its wire time: the rate of an adaptive host grows while answers stay quick. */
  observe(host: string, wireMs: number): void {
    const s = this.state(host)
    const a = s.adaptive
    if (!a || !Number.isFinite(wireMs) || wireMs < 0) return
    const now = this.clock.now()
    a.samples += 1
    a.ewma = a.ewma === undefined ? wireMs : a.ewma * 0.8 + wireMs * 0.2
    if (a.samples >= BASELINE_SAMPLES) a.best = Math.min(a.best ?? a.ewma, a.ewma)
    if (a.best !== undefined && a.ewma > a.best * 4 + 500) {
      // Straining: give back a quarter, and wait before trying again.
      if (now >= a.holdUntil) {
        a.rate = Math.max(MIN_ADAPTIVE_RPS, a.rate * 0.75)
        a.threshold = a.rate
        a.holdUntil = now + HOLD_AFTER_STRAIN_MS
      }
      a.streak = 0
      return
    }
    if (a.best !== undefined && a.ewma > a.best * 2 + 200) {
      a.streak = 0
      return
    }
    a.streak += 1
    if (a.streak >= Math.ceil(a.rate) && now >= a.holdUntil) {
      a.streak = 0
      a.rate = Math.min(a.max, a.rate < a.threshold ? a.rate * 1.5 : a.rate + 1)
      a.peak = Math.max(a.peak, a.rate)
    }
  }

  /** A 429 (or 503 with Retry-After): halve the rate. */
  penalise(host: string): void {
    const s = this.state(host)
    const now = this.clock.now()
    if (s.adaptive) {
      s.adaptive.rate = Math.max(MIN_ADAPTIVE_RPS, s.adaptive.rate / 2)
      s.adaptive.threshold = s.adaptive.rate
      s.adaptive.streak = 0
      s.adaptive.holdUntil = now + HOLD_AFTER_LIMIT_MS
      return
    }
    s.penalty = Math.min(s.penalty * 2, MAX_PENALTY)
    s.penaltyAt = now
  }

  /** A firewall or bot wall answered: slow right down and pause; `stop` once the host has walled `WALL_LIMIT` times. */
  wall(host: string): WallVerdict {
    const s = this.state(host)
    const now = this.clock.now()
    s.walls += 1
    if (s.adaptive) Object.assign(s.adaptive, { rate: MIN_ADAPTIVE_RPS, threshold: MIN_ADAPTIVE_RPS, streak: 0, holdUntil: now + HOLD_AFTER_LIMIT_MS })
    else { s.penalty = MAX_PENALTY; s.penaltyAt = now }
    s.pausedUntil = Math.max(s.pausedUntil, now + Math.min(WALL_PAUSE_MS * 2 ** (s.walls - 1), MAX_WALL_PAUSE_MS))
    return s.walls >= WALL_LIMIT ? 'stop' : 'pause'
  }

  /** Whether `host` has walled often enough that nothing more should be sent to it. */
  walled(host: string): boolean {
    const s = this.hosts.get(host)
    return !!s && s.walls >= WALL_LIMIT && this.clock.now() - s.lastUsed <= IDLE_FORGET_MS
  }

  intervalMs(host: string, rps: number): number {
    const s = this.state(host)
    const delay = s.crawlDelayMs ?? 0
    if (s.adaptive) return Math.max(1000 / s.adaptive.rate, delay)
    return Math.max(1000 / rps, delay) * s.penalty
  }

  /** Waits for this host's next free slot. Returns at once if `signal` aborts. */
  async wait(host: string, rps: number, signal?: AbortSignal): Promise<void> {
    const s = this.state(host)
    const now = this.clock.now()
    const slot = Math.max(now, s.nextSlot, s.pausedUntil)
    s.nextSlot = slot + this.intervalMs(host, rps)
    s.lastUsed = slot
    if (slot > now) await this.clock.sleep(slot - now, signal)
  }
}

/** The process-wide throttle used when a job does not bring its own. */
export const sharedThrottle = new HostThrottle()
