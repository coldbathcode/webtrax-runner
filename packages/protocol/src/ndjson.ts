import { RunLine } from './schemas'

/** One record per line, no trailing spaces, newline-terminated. */
export const toNdjsonLine = (record: RunLine): string => `${JSON.stringify(RunLine.parse(record))}\n`

export type ParsedLine = { ok: true; line: number; record: RunLine } | { ok: false; line: number; error: string }

/**
 * Parses a run's NDJSON. Blank lines are skipped; every other line is
 * validated, and failures are reported with their line number rather than
 * thrown, so a reader can show every problem at once.
 */
export function parseNdjson(text: string): ParsedLine[] {
  const out: ParsedLine[] = []
  text.split('\n').forEach((raw, i) => {
    if (!raw.trim()) return
    let json: unknown
    try {
      json = JSON.parse(raw)
    } catch (e) {
      out.push({ ok: false, line: i + 1, error: `invalid JSON: ${(e as Error).message}` })
      return
    }
    const result = RunLine.safeParse(json)
    out.push(result.success ? { ok: true, line: i + 1, record: result.data } : { ok: false, line: i + 1, error: result.error.issues.map((x) => `${x.path.join('.') || '(root)'}: ${x.message}`).join('; ') })
  })
  return out
}
