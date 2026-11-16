/**
 * Per-host politeness (pipeline doc §2, OPS-08, COR-09, COR-12).
 *
 * One HostThrottle is shared by every job in a process, so two scans of the
 * same site do not double its load. Each host gets a minimum interval between
 * request starts: 1 / rps, or its robots.txt Crawl-delay if longer, times a
 * penalty that doubles on every 429 or 503-with-Retry-After for the rest of
 * the process. Slots are reserved synchronously before awaiting, so
 * concurrent callers queue up instead of all seeing the same "last request"
 * time and firing together (v1 COR-09).
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

export class HostThrottle {
  private readonly nextSlot = new Map<string, number>()
  private readonly crawlDelayMs = new Map<string, number>()
  private readonly penalty = new Map<string, number>()

  constructor(private readonly clock: ThrottleClock = realClock) {}

  /** Honour a robots.txt Crawl-delay for `host`, capped at 30 s. */
  setCrawlDelay(host: string, seconds: number): void {
    if (Number.isFinite(seconds) && seconds > 0) this.crawlDelayMs.set(host, Math.min(seconds, MAX_CRAWL_DELAY_SECONDS) * 1000)
  }

  /** Halve the request rate for `host` (after a 429). */
  penalise(host: string): void {
    this.penalty.set(host, Math.min((this.penalty.get(host) ?? 1) * 2, MAX_PENALTY))
  }

  intervalMs(host: string, rps: number): number {
    return Math.max(1000 / rps, this.crawlDelayMs.get(host) ?? 0) * (this.penalty.get(host) ?? 1)
  }

  /** Waits for this host's next free slot. Returns at once if `signal` aborts. */
  async wait(host: string, rps: number, signal?: AbortSignal): Promise<void> {
    const now = this.clock.now()
    const slot = Math.max(now, this.nextSlot.get(host) ?? now)
    this.nextSlot.set(host, slot + this.intervalMs(host, rps))
    if (slot > now) await this.clock.sleep(slot - now, signal)
  }
}

/** The process-wide throttle used when a job does not bring its own. */
export const sharedThrottle = new HostThrottle()
