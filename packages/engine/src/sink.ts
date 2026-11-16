/**
 * Where a run's records go (pipeline doc §1). LocalSink writes the CLI's run
 * directory; CloudSink (agent mode, C05.8) and TeeSink come later. Every
 * record is validated against the protocol before it is written.
 */
import { createWriteStream, mkdirSync, type WriteStream } from 'node:fs'
import { join } from 'node:path'
import { RunLine, toNdjsonLine } from '@webtrax/protocol'

export interface Sink {
  write(record: RunLine): void | Promise<void>
  close(): Promise<void>
}

/** Keeps records in memory (tests, `webtrax mcp`). */
export class MemorySink implements Sink {
  readonly records: RunLine[] = []
  write(record: RunLine): void {
    this.records.push(RunLine.parse(record))
  }
  async close(): Promise<void> {}
  of<T extends RunLine['type']>(type: T): Extract<RunLine, { type: T }>[] {
    return this.records.filter((r): r is Extract<RunLine, { type: T }> => r.type === type)
  }
}

/** `<root>/.webtrax/runs/<timestamp>/run.ndjson` (or `<runsDir>/<timestamp>/…`), one validated record per line. */
export class LocalSink implements Sink {
  readonly dir: string
  readonly file: string
  private readonly stream: WriteStream

  constructor(root: string, startedAt = new Date(), runsDir = join(root, '.webtrax', 'runs')) {
    this.dir = join(runsDir, startedAt.toISOString().replace(/[:.]/g, '-'))
    mkdirSync(this.dir, { recursive: true })
    this.file = join(this.dir, 'run.ndjson')
    this.stream = createWriteStream(this.file, { flags: 'wx' })
  }

  write(record: RunLine): void {
    this.stream.write(toNdjsonLine(record))
  }

  close(): Promise<void> {
    return new Promise((resolve, reject) => this.stream.end((err?: Error | null) => (err ? reject(err) : resolve())))
  }
}

/** Sends every record to several sinks (local report plus cloud upload). */
export class TeeSink implements Sink {
  constructor(private readonly sinks: Sink[]) {}
  async write(record: RunLine): Promise<void> {
    for (const s of this.sinks) await s.write(record)
  }
  async close(): Promise<void> {
    await Promise.all(this.sinks.map((s) => s.close()))
  }
}
