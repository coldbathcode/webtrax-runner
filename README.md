# Webtrax runner

The open source engine behind [Webtrax](https://webtrax.dev), the agentic platform for website quality. It crawls a website once and checks it for broken links, redirect problems, missing security headers, SEO basics and, later, accessibility and performance. It writes reports for people, CI and coding agents, and runs as a local MCP server so a coding agent can check `localhost` before it commits.

## Use it

```bash
npx @webtrax/cli check https://your-site.example            # links, security, SEO
npx @webtrax/cli check https://your-site.example --browser  # + accessibility and performance (needs Chromium)
claude mcp add webtrax -- npx -y @webtrax/cli mcp           # local MCP server for coding agents
```

GitHub Action: `uses: coldbathcode/webtrax-runner/action@v0` with `url:` (see [action/README.md](action/README.md)). Cursor (`.cursor/mcp.json`): `{ "mcpServers": { "webtrax": { "command": "npx", "args": ["-y", "@webtrax/cli", "mcp"] } } }`. The MCP server checks only local targets (localhost, `*.local`, private IPs) unless started with `--allow-public`.

**Docs:** [docs.webtrax.dev](https://docs.webtrax.dev/) (getting started, CLI, MCP, CI, every rule).

## Develop

Node.js 22.19+ and pnpm 10. `pnpm install`, then `pnpm run check` (typecheck, lint, tests; some tests need Chromium: `pnpm --filter @webtrax/net-proxy exec playwright-core install chromium`) and `pnpm run build`. See [CONTRIBUTING.md](CONTRIBUTING.md).

| Package | What | State |
|---|---|---|
| `@webtrax/protocol` | Job spec and run records (Zod + JSON Schema), fingerprints, the WebtraxBot identity | Built (C05.1) |
| `@webtrax/net-guard` | Scope policy and guarded fetch: no private networks or cloud metadata, every redirect and DNS answer checked | Built (C05.2) |
| `@webtrax/net-proxy` | Egress proxy for the browser stage: Chromium reaches the network only through the scope policy | Built (C05.10) |
| `@webtrax/engine` | Crawl engine: one fetch per URL, robots.txt, sitemaps, per-host politeness, 429 handling, time budget and cancellation | Built (C05.3) |
| `@webtrax/suite-links`, `@webtrax/suite-security`, `@webtrax/suite-seo` | Check suites: broken links, redirects, sitemaps and canonicals; passive security (HTTPS, headers, CSP, mixed content); SEO basics | Built (C05.4) |
| `@webtrax/reporters` | Console, JSON/NDJSON, Markdown (for PRs and LLMs), single-file accessible HTML | Built (C05.5) |
| `@webtrax/cli` | `webtrax check`, `init`, `diff`, `explain`, `doctor`, and `webtrax mcp` (local MCP server for coding agents) | Built (C05.6, C05.7) |

The crawler identifies itself as `Mozilla/5.0 (compatible; WebtraxBot/1.0; +https://webtrax.dev/bot)` and honours `robots.txt` and `Crawl-delay`. See [webtrax.dev/bot](https://webtrax.dev/bot).

Licensed under the [Apache License 2.0](LICENSE).
