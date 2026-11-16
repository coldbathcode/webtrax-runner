# @webtrax/suite-links

Links suite (C05.4). Reads the crawl's link outcomes and edges (`SiteState`); makes no requests. Rules and their fix guidance are in `LINK_RULES` (`src/index.ts`), each `RuleMeta` v1.

- One finding per broken target **and** source page; the fingerprint is per target, so the cloud groups the source pages as occurrences.
- `resolveOutcome` follows a redirect the engine stopped at a known page through that page's own result (effective status, total hops). A redirect that ends broken is reported as broken, not as a chain; a chain is > 2 hops.
- A URL only in the sitemap that errors is `links.sitemap.stale` (low, per rebuild/08), not `links.broken.internal` as v1 reported it.
- Rate-limited and robots-skipped targets are never broken (`linkProblem` in the engine); a host that stayed rate limited gets one `links.host_rate_limited` info finding.
- Not yet: `links.anchor.missing`, `links.asset.broken` (browser stage / asset checks, C05.10).
