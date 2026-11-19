# @webtrax/suite-ai

AI readiness (C06.6, first slice; `plan/06-check-suites/ai-readiness-and-monitors.md` §1), suite id `ai_readiness`, rule ids `ai_readiness.*`. HTTP only, on by default in the CLI and hosted scans.

- `onPage`: `ai_readiness.schema.invalid` for JSON-LD blocks that do not parse; counts 200 pages with and without JSON-LD per crawl (a `WeakMap` keyed by the crawl's `SuiteCtx`; suites are shared objects).
- `onSite`: `/llms.txt` through `ctx.text` (`ai_readiness.llms_txt.missing`, or `ai_readiness.llms_txt.invalid` for HTML served at that path, no `# Title` first, no markdown links, or same-site links that do not answer: up to 20, crawled pages are not fetched again); `ai_readiness.schema.none` when no page had JSON-LD; robots.txt read for each of `AI_CRAWLERS` with the engine's `parseRobots` (an info `ai_readiness.crawlers.policy` finding with the allow/block matrix, keyed by the blocked list so a changed policy is a new finding) and `ai_readiness.crawlers.inconsistent` per vendor in `CRAWLER_PAIRS` whose search crawler and user-triggered agent differ.
- Never probes with another crawler's user agent, and never says which policy is right: the policy is the owner's choice.
- Not yet: `ai_readiness.render.js_only` (needs the browser stage), `ai_readiness.extract.noisy`, `ai_readiness.llms_full.stale`, `ai_readiness.crawlers.waf_blocked`.
