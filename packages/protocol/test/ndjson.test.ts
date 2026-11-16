import { describe, expect, it } from 'vitest'
import { parseNdjson, toNdjsonLine, type RunLine } from '../src'

const page: RunLine = { type: 'page', url: 'https://example.com/', final_url: 'https://example.com/', status: 200, depth: 0, redirect_chain: [] }

describe('NDJSON', () => {
  it('round-trips a record on one line', () => {
    const line = toNdjsonLine(page)
    expect(line.endsWith('\n')).toBe(true)
    expect(line.slice(0, -1)).not.toContain('\n')
    expect(parseNdjson(line)).toEqual([{ ok: true, line: 1, record: page }])
  })

  it('refuses to write an invalid record', () => {
    expect(() => toNdjsonLine({ ...page, status: 42 } as never)).toThrow()
  })

  it('reports every bad line with its number and skips blanks', () => {
    const text = [toNdjsonLine(page).trim(), '', '{not json', JSON.stringify({ ...page, url: 'ftp://x' }), JSON.stringify({ type: 'nope' })].join('\n')
    const parsed = parseNdjson(text)
    expect(parsed.map((p) => [p.line, p.ok])).toEqual([[1, true], [3, false], [4, false], [5, false]])
    const bad = parsed.filter((p) => !p.ok)
    expect(bad[0]).toMatchObject({ error: expect.stringContaining('invalid JSON') })
    expect(bad[1]).toMatchObject({ error: expect.stringContaining('url') })
  })
})
