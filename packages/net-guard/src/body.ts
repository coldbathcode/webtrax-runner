/**
 * Reading response bodies with a cap (COR-11). The crawler reads at most a few
 * megabytes of an HTML page and nothing of other content types; without a
 * cap, one huge or endless response holds memory and a connection for the
 * whole crawl. Counts decoded bytes (after gzip or brotli), so a small
 * compressed bomb cannot get past it.
 */
import type { Response } from 'undici'

/** Default cap for HTML pages: 5 MB (pipeline doc §2). */
export const DEFAULT_MAX_BODY_BYTES = 5 * 1024 * 1024

export interface CappedBody { bytes: Uint8Array; truncated: boolean }

export async function readBodyCapped(response: Response, maxBytes = DEFAULT_MAX_BODY_BYTES): Promise<CappedBody> {
  if (!response.body) return { bytes: new Uint8Array(0), truncated: false }
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  let truncated = false
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    const room = maxBytes - size
    if (value.byteLength > room) {
      chunks.push(value.subarray(0, room))
      size += room
      truncated = true
      await reader.cancel().catch(() => {})
      break
    }
    chunks.push(value)
    size += value.byteLength
  }
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const c of chunks) {
    bytes.set(c, offset)
    offset += c.byteLength
  }
  return { bytes, truncated }
}

/** Decodes a capped body as UTF-8 (invalid sequences become U+FFFD; charset sniffing comes with the parser in C05.3). */
export async function readTextCapped(response: Response, maxBytes = DEFAULT_MAX_BODY_BYTES): Promise<{ text: string; truncated: boolean }> {
  const { bytes, truncated } = await readBodyCapped(response, maxBytes)
  return { text: new TextDecoder('utf-8').decode(bytes), truncated }
}

/** Releases a response without reading it (non-HTML bodies, HEAD fallbacks). */
export async function discardBody(response: Response): Promise<void> {
  await response.body?.cancel().catch(() => {})
}
