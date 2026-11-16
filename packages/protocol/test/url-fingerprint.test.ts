import { describe, expect, it } from 'vitest'
import { BOT_USER_AGENT, fingerprint, normaliseUrl } from '../src'

describe('normaliseUrl (v1 semantics)', () => {
  it.each([
    ['https://Example.COM:443/a/#top', 'https://example.com/a'],
    ['https://example.com', 'https://example.com/'],
    ['https://example.com/', 'https://example.com/'],
    ['http://example.com:80/x?b=2&a=1', 'http://example.com/x?b=2&a=1'],
    ['  https://example.com/docs/  ', 'https://example.com/docs'],
  ])('%s -> %s', (input, expected) => expect(normaliseUrl(input)).toBe(expected))

  it('resolves relative links against a base', () => expect(normaliseUrl('../b/', 'https://example.com/a/c')).toBe('https://example.com/b'))

  it.each(['#top', 'mailto:a@b.c', 'tel:123', 'javascript:void(0)', 'data:text/plain,x', 'ftp://example.com', 'not a url', ''])(
    'rejects %j', (input) => expect(normaliseUrl(input)).toBeNull(),
  )
})

describe('fingerprint', () => {
  it('is a sha256 of rule, normalised URL and evidence key (known vector)', async () => {
    // printf 'links.broken.internal\nhttps://example.com/a\nhttps://example.com/missing' | shasum -a 256
    expect(await fingerprint('links.broken.internal', 'https://example.com/a', 'https://example.com/missing')).toBe('ae418201bd0ce463e4adfa18454f08ca5a0500916fba85478b2f1e946e4b145a')
  })

  it('ignores differences that normalisation removes', async () => {
    const a = await fingerprint('security.header.missing', 'https://EXAMPLE.com/a/#x', 'strict-transport-security')
    const b = await fingerprint('security.header.missing', 'https://example.com/a', 'strict-transport-security')
    expect(a).toBe(b)
  })

  it('changes with the rule, the URL or the evidence key', async () => {
    const base = await fingerprint('links.broken.internal', 'https://example.com/a', 'k')
    expect(await fingerprint('links.broken.external', 'https://example.com/a', 'k')).not.toBe(base)
    expect(await fingerprint('links.broken.internal', 'https://example.com/b', 'k')).not.toBe(base)
    expect(await fingerprint('links.broken.internal', 'https://example.com/a', 'j')).not.toBe(base)
    expect(await fingerprint('links.broken.internal', null, 'k')).toMatch(/^[0-9a-f]{64}$/)
  })
})

describe('bot identity', () => {
  it('is the published WebtraxBot user agent', () => {
    expect(BOT_USER_AGENT).toBe('Mozilla/5.0 (compatible; WebtraxBot/1.0; +https://webtrax.dev/bot)')
  })
})
