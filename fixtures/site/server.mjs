// A small website with known structure, used to test the crawl loop end to end
// (v1: apps/legacy/tests/integration/crawl-loop.test.ts; v2: runner/packages/engine
// golden tests). It is served from code rather than
// static files so it can redirect, fail, and log every request it receives.
// Owned by the runner since C05.3; the check-suite golden tests (C06) extend it.
//
// Layout (internal pages reachable by crawling are marked *):
//   / *             -> /about, /blog, /missing (404), /old-page (301 -> /about),
//                      /private/secret (robots-disallowed for WebtraxBot),
//                      two external links (served on the "external" origin)
//   /about *        -> /, /blog, /blog/ (duplicate of /blog), /about#team
//   /blog *         -> /blog/post-1, /blog/post-2, /server-error (500)
//   /blog/post-1 *  -> /blog/post-2, /about
//   /blog/post-2 *  -> /missing (same broken link, second source page)
//   /orphan *       -> only reachable from sitemap.xml; links /orphan-child
//   /orphan-child * -> no links
//   sitemap.xml lists /, /about, /orphan and /gone-from-sitemap (404)

import http from 'node:http'

const page = (title, links) =>
  `<!doctype html><html><head><title>${title}</title></head><body><h1>${title}</h1>` +
  links.map((href) => `<a href="${href}">${href}</a>`).join('\n') +
  '</body></html>'

export const EXPECTED = {
  crawledPages: ['/', '/about', '/blog', '/blog/post-1', '/blog/post-2', '/orphan', '/orphan-child'],
  brokenInternal: ['/missing', '/server-error', '/gone-from-sitemap'],
  brokenExternal: ['/external-missing'],
}

/**
 * @param {{ mode?: 'normal' | 'down' | 'slow' }} [options]  slow: every page takes 400ms
 * @returns {Promise<{ origin: string, externalOrigin: string, requests: Array<{method: string, path: string, host: string, ua: string}>, close: () => Promise<void> }>}
 */
export async function startFixtureSite({ mode = 'normal' } = {}) {
  const requests = []
  let origin = ''
  let externalOrigin = ''

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://fixture')
    if (mode === 'slow' && !url.pathname.endsWith('.txt') && !url.pathname.endsWith('.xml')) {
      await new Promise((resolve) => setTimeout(resolve, 400))
    }
    requests.push({ method: req.method, path: url.pathname, host: req.headers.host, ua: req.headers['user-agent'] || '' })

    const send = (status, body = '', type = 'text/html; charset=utf-8', headers = {}) => {
      res.writeHead(status, { 'content-type': type, ...headers })
      res.end(req.method === 'HEAD' ? undefined : body)
    }

    if (mode === 'down') return send(503, 'Service Unavailable', 'text/plain')

    const ext = externalOrigin
    switch (url.pathname) {
      case '/robots.txt':
        return send(200, 'User-agent: WebtraxBot\nDisallow: /private\n\nUser-agent: *\nDisallow:\n', 'text/plain')
      case '/sitemap.xml':
        return send(
          200,
          `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">` +
            ['/', '/about', '/orphan', '/gone-from-sitemap'].map((p) => `<url><loc>${origin}${p}</loc></url>`).join('') +
            '</urlset>',
          'application/xml'
        )
      case '/':
        return send(200, page('Home', [
          '/about', '/blog', '/missing', '/old-page', '/private/secret',
          `${ext}/external-ok`, `${ext}/external-missing`, '#top', 'mailto:hi@example.test',
        ]))
      case '/about':
        return send(200, page('About', ['/', '/blog', '/blog/', '/about#team']))
      case '/blog':
        return send(200, page('Blog', ['/blog/post-1', '/blog/post-2', '/server-error']))
      case '/blog/post-1':
        return send(200, page('Post 1', ['/blog/post-2', '/about']))
      case '/blog/post-2':
        return send(200, page('Post 2', ['/missing']))
      case '/orphan':
        return send(200, page('Orphan', ['/orphan-child']))
      case '/orphan-child':
        return send(200, page('Orphan child', []))
      case '/private/secret':
        return send(200, page('Private', ['/private/deeper']))
      case '/private/deeper':
        return send(200, page('Deeper', []))
      case '/old-page':
        return send(301, '', 'text/plain', { location: '/about' })
      case '/server-error':
        return send(500, 'boom', 'text/plain')
      case '/external-ok':
        return send(200, page('External', []))
      default:
        return send(404, page('Not found', []))
    }
  })

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  origin = `http://127.0.0.1:${port}`
  // Same server, different origin: the crawler must treat it as external.
  externalOrigin = `http://localhost:${port}`

  return {
    origin,
    externalOrigin,
    requests,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  }
}

/**
 * A second origin on the same host that 301s every request to `target`,
 * standing in for http->https or apex->www redirects (COR-01).
 */
export async function startRedirector(target) {
  const server = http.createServer((req, res) => {
    res.writeHead(301, { location: new URL(req.url, target).toString() })
    res.end()
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  return {
    origin: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  }
}
