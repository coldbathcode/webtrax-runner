## Webtrax report: https://shop.example/

- Status: partial (time budget)
- Pages crawled: 1; links checked: 12; duration: 1 min 6 s
- Health score: 80 out of 100 (B) ([how it is worked out](https://docs.webtrax.dev/health-score/))
- Findings: 1 high, 1 medium, 1 low, 1 info
- Suites: links 1.0.0, security 1.0.0, seo 1.0.0

### High (1)

- **Broken internal link** `links.broken.internal` `aaaaaaaaaa`
  - URL: <https://shop.example/old>
  - Seen on: <https://shop.example/>, <https://shop.example/blog>
  - Evidence: status: 404; link\_text: Old \<b\>offer\</b\>
  - Fix: Point the link at the page that exists now.

### Medium (1)

- **Content-Security-Policy missing** `security.header.csp_missing` `bbbbbbbbbb`
  - URL: <https://shop.example/>
  - Fix: Add a Content-Security-Policy.

### Low (1)

- **Page does not declare its language** `seo.lang.missing` `cccccccccc`
  - URL: <https://shop.example/>
  - Fix: Add \<html lang="en"\>.

### Info (1)

- **A rule the reporter has no metadata for** `seo.unknown_rule` `dddddddddd`
  - URL: site-wide
  - Evidence: examples: javascript:alert(1), https://x.example/
