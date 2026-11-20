import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { crawl, HostThrottle, MemorySink, parseHtml } from '@webtrax/engine'
import { CONTENT_RULES, contentSuite, copyrightYear, findPlaceholders, simhash, visibleText, wordCount } from '../src'

const doc = (body: string) => parseHtml(`<!doctype html><html lang="en"><head><title>T</title></head><body>${body}</body></html>`, 'https://site.example/').$
const kinds = (text: string) => findPlaceholders(text).map((p) => p.kind)

describe('visible text', () => {
  it('keeps blocks apart, words in links apart, and leaves out code and anything that is not prose', () => {
    const $ = doc('<nav><a href="/">Home</a><a href="/a">About</a></nav><main><h1>Title</h1><p>Click <a href="/x">here</a> to read.</p><pre>{{ user }}</pre><p>Use <code>undefined</code> with care.</p><script>var x = "lorem ipsum"</script></main><footer>© 2020 Us</footer>')
    expect(visibleText($)).toBe('Home About\nTitle\nClick here to read.\nUse with care.\n© 2020 Us')
    expect(visibleText($, true)).toBe('Title\nClick here to read.\nUse with care.')
    expect(wordCount('It’s a well-made page, no. 1 in 2026.')).toBe(8)
  })
})

describe('placeholder text', () => {
  it('finds filler, editor prompts, insert markers, unrendered template tags and values that printed as nothing', () => {
    expect(kinds('Lorem ipsum dolor sit amet')).toEqual(['lorem_ipsum'])
    expect(kinds('Click here to edit')).toEqual(['editor_prompt'])
    expect(kinds('Your title goes here')).toEqual(['editor_prompt'])
    expect(kinds('Contact [insert phone number] today')).toEqual(['insert_marker'])
    expect(kinds('Hello {{ user.first_name }}, welcome')).toEqual(['template_tag'])
    expect(kinds('{% if cart %}Your cart{% endif %}')).toEqual(['template_tag'])
    expect(kinds('Total: ${total}')).toEqual(['template_tag'])
    expect(kinds('undefined')).toEqual(['empty_value'])
    expect(kinds('Price: $NaN')).toEqual(['empty_value'])
    expect(kinds('NaN reviews')).toEqual(['empty_value'])
    expect(kinds('Name: undefined')).toEqual(['empty_value'])
    expect(kinds('Welcome [object Object]')).toEqual(['empty_value'])
    // The quote is the match with 30 characters either side.
    expect(findPlaceholders(`${'Before. '.repeat(10)}Then lorem ipsum dolor sit amet, and a long line after it that goes on.`)[0]!.quote).toBe('… Before. Before. Before. Then lorem ipsum dolor sit amet, and a long line aft…')
    // On a page about code a lone value is a heading or a table cell; beside a price it is still a bug.
    expect(findPlaceholders('NaN\nundefined\nPrice: $NaN', { loneValues: false }).map((p) => p.quote)).toEqual(['Price: $NaN'])
    expect(findPlaceholders('NaN\nnull', { loneValues: false })).toEqual([])
    // One of each kind per page, however often it repeats.
    expect(kinds('lorem ipsum\nLorem ipsum again\nundefined\nnull')).toEqual(['lorem_ipsum', 'empty_value'])
  })

  it('leaves ordinary prose alone', () => {
    for (const fine of [
      'The value is undefined behaviour in C.', 'We return null when nothing matches.', 'NaN stands for not a number.', 'Add it to your TODO list.', 'Prices from $5 to $50.',
      'Use double braces {{ like this in Handlebars.', 'See [1] and [note] below.', 'Click here to read more.', 'Insert the card and press OK.', 'Your content is yours.',
      'Results: 12 items', 'Save 50% today', 'A JSON object { "a": 1 }',
      'We check for placeholder text, lorem ipsum, stale copyright dates and empty pages.', 'A page builder that still shows "Click here to edit" in a heading tells every visitor the page was never finished.',
    ]) expect(kinds(fine), fine).toEqual([])
  })
})

describe('copyright year', () => {
  it('reads the latest year of a notice, in its usual forms', () => {
    expect(copyrightYear('© 2019 Shop Ltd')).toEqual({ year: 2019, quote: '© 2019' })
    expect(copyrightYear('Copyright © 2015-2021 Shop')!.year).toBe(2021)
    expect(copyrightYear('(c) 2018–24 Shop')!.year).toBe(2024)
    expect(copyrightYear('Copyright 2020 to 2023, Shop')!.year).toBe(2023)
    expect(copyrightYear('© Shop Ltd 2022. All rights reserved')!.year).toBe(2022)
    expect(copyrightYear('© 2020 A\n© 2026 B')!.year).toBe(2026)
    expect(copyrightYear('Founded in 1999. Call 2020 555 0100.')).toBeNull()
    expect(copyrightYear('© Shop Ltd')).toBeNull()
    // A sentence about copyright is not a notice (this was the suite's own help text, on its docs page).
    expect(copyrightYear('Update the year, or print the current year from your template so it never falls behind (for example "© 2019 to this year"), then deploy.')).toBeNull()
  })
})

describe('alike texts', () => {
  const bits = (a: bigint, b: bigint) => (a ^ b).toString(2).replace(/0/g, '').length
  const base = Array.from({ length: 120 }, (_, i) => `word${i % 37} thing${i} other${(i * 7) % 11}`).join(' ')
  it('gives the same text the same fingerprint, a small edit a near one, another text a far one', () => {
    expect(simhash(base)).toBe(simhash(base.toUpperCase().replace(/ /g, '  ')))
    expect(bits(simhash(base), simhash(`${base} and one more sentence here`))).toBeLessThanOrEqual(3)
    const other = Array.from({ length: 120 }, (_, i) => `apple${i} pear${i % 5} plum${(i * 3) % 13}`).join(' ')
    expect(bits(simhash(base), simhash(other))).toBeGreaterThan(12)
  })
})

const para = (seed: string, n = 30) => Array.from({ length: n }, (_, i) => `${seed} sentence number ${i} talks about ${seed}${i * 3} and ${seed}${i * 7}.`).join(' ')
const html = (title: string, main: string, head = '', year = 2026) => `<!doctype html><html lang="en"><head><title>${title}</title>${head}</head><body><nav><a href="/">Home</a> <a href="/about">About</a> <a href="/copy">Copy</a> <a href="/copy2">Copy 2</a> <a href="/canon">Canon</a> <a href="/empty">Empty</a> <a href="/stub">Stub</a> <a href="/draft">Draft</a> <a href="/docs">Docs</a> <a href="/gallery">Gallery</a> <a href="/login">Sign in</a> <a href="/nan">NaN</a></nav><main>${main}</main><footer><p>© 2019-${year} Shop Ltd</p></footer></body></html>`

let origin: string
let server: http.Server
let year = 2026
beforeAll(async () => {
  server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' })
    const page = (title: string, main: string, head = '') => res.end(html(title, main, head, year))
    if (req.url === '/') return page('Home', `<h1>Shop</h1><p>${para('home')}</p><p>Hello {{ customer.name }}, your total is $NaN.</p>`)
    if (req.url === '/about') return page('About', `<h1>About</h1><p>${para('about')}</p>`)
    if (req.url === '/copy') return page('Copy', `<h1>About us</h1><p>${para('about')}</p>`)
    if (req.url === '/copy2') return page('Copy 2', `<h1>About</h1><p>${para('about')}</p><p>Last line differs.</p>`)
    // Says it is a copy of /about: not reported.
    if (req.url === '/canon') return page('Canon', `<h1>About</h1><p>${para('about')}</p>`, '<link rel="canonical" href="/about">')
    if (req.url === '/empty') return page('Empty', '<h1>Coming soon</h1>')
    if (req.url === '/stub') return page('Stub', '<p>Moved.</p>', '<meta http-equiv="refresh" content="0; url=/about">')
    if (req.url === '/draft') return page('Draft', '<p>Lorem ipsum.</p>', '<meta name="robots" content="noindex">')
    // Documentation that shows template tags and values as code is fine.
    if (req.url === '/docs') return page('Docs', `<h1>Templates</h1><p>${para('docs')}</p><p>Write <code>{{ name }}</code> to print a name; an unset one prints <code>undefined</code>.</p><pre>Lorem ipsum {{ x }}\nNaN</pre>`)
    // Few words, but its images say what it is.
    if (req.url === '/gallery') return page('Gallery', `<h1>Gallery</h1>${Array.from({ length: 12 }, (_, i) => `<img src="/i${i}.jpg" alt="Our shop front seen from the street, photo ${i}">`).join('')}`)
    // A sign-in page has a form, not prose.
    if (req.url === '/login') return page('Sign in', '<h1>Sign in</h1><form method="post"><label>Email <input type="email" name="e"></label><button>Continue</button></form>')
    // A reference page named after a value, with the value in a table and no code markup around it.
    if (req.url === '/nan') return page('NaN', `<h1>NaN</h1><p>${para('nan')}</p><table><tr><th>Value</th></tr><tr><td>NaN</td></tr><tr><td>undefined</td></tr></table>`)
    res.end('')
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})
afterAll(() => new Promise<void>((r) => server.close(() => r())))

const run = (today: string) => crawl(
  { spec_version: 1, job_id: 'c', target: { start_url: `${origin}/` }, scope: { allow_private: true }, limits: { per_host_rps: 50 }, suites: { content: { enabled: true, config: { today } } } },
  { sink: new MemorySink(), throttle: new HostThrottle(), suites: [contentSuite] },
)
const at = (r: Awaited<ReturnType<typeof run>>, id: string) => r.findings.filter((f) => f.rule_id === id).map((f) => [f.url?.replace(origin, '') ?? null, f.evidence] as const)

describe('content suite on a site', () => {
  it('declares its rules with docs pages', () => {
    expect(CONTENT_RULES.map((r) => [r.id, r.severity, r.docs_slug])).toEqual([
      ['content.placeholder', 'high', 'content-placeholder'], ['content.copyright_stale', 'low', 'content-copyright-stale'],
      ['content.empty_page', 'medium', 'content-empty-page'], ['content.duplicate', 'low', 'content-duplicate'],
    ])
  })

  it('reports each seeded defect once, and none of the pages that only look like one', async () => {
    year = 2026
    const r = await run('2026-11-20')
    expect(r.suiteErrors).toEqual([])
    // The home page: an unrendered tag and a NaN price. The noindex draft's lorem ipsum too: a visitor can still read it. Not the docs page's code.
    expect(at(r, 'content.placeholder').map(([u, e]) => [u, (e as { kind: string }).kind]).sort()).toEqual([['/', 'empty_value'], ['/', 'template_tag'], ['/draft', 'lorem_ipsum']])
    expect(at(r, 'content.placeholder').find(([, e]) => (e as { kind: string }).kind === 'template_tag')![1]).toMatchObject({ quote: expect.stringContaining('{{ customer.name }}') })
    // Empty: only the page with a heading and nothing else. Not the redirect stub, the noindex draft, the gallery or the sign-in form.
    expect(at(r, 'content.empty_page')).toEqual([['/empty', { words: 2, title: 'Empty' }]])
    // /about, /copy and /copy2 say the same thing; /canon has declared itself a copy.
    expect(at(r, 'content.duplicate')).toEqual([['/about', { pages: 3, same_as: [`${origin}/copy`, `${origin}/copy2`], words: expect.any(Number) }]])
    expect(r.findings.find((f) => f.rule_id === 'content.duplicate')!.title).toBe('3 pages with the same content')
    // The footer names this year.
    expect(at(r, 'content.copyright_stale')).toEqual([])
  }, 60_000)

  it('reports a stale copyright year once for the site, with where it was seen', async () => {
    year = 2024
    const r = await run('2026-01-05')
    const found = at(r, 'content.copyright_stale')
    expect(found).toHaveLength(1)
    expect(found[0]).toEqual([null, { year: 2024, this_year: 2026, quote: '© 2019-2024', seen_on: expect.stringContaining(origin), pages: 12 }])
    expect(r.findings.find((f) => f.rule_id === 'content.copyright_stale')).toMatchObject({ severity: 'low', title: 'Copyright year is 2024' })
    year = 2026
  }, 60_000)
})
