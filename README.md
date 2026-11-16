# Webtrax runner

The open source engine behind [Webtrax](https://webtrax.dev), the agentic platform for website quality. It crawls a website once and checks it for broken links, redirect problems, missing security headers, SEO basics and, later, accessibility and performance. It writes reports for people, CI and coding agents, and runs as a local MCP server so a coding agent can check `localhost` before it commits.

**Status: in development.** Nothing here is released yet. The first public release is the alpha:

```bash
npx @webtrax/cli check https://your-site.example     # not published yet
claude mcp add webtrax -- npx -y @webtrax/cli mcp    # not published yet
```

| Package | What | State |
|---|---|---|
| `@webtrax/protocol` | Job spec and run records (Zod + JSON Schema), fingerprints, the WebtraxBot identity | Built (C05.1) |
| `@webtrax/net-guard` | Scope policy and guarded fetch: no private networks or cloud metadata, every redirect and DNS answer checked | Built (C05.2) |
| `@webtrax/engine` | Crawl engine: one fetch per URL, robots.txt, sitemaps, per-host politeness, 429 handling, time budget and cancellation | Built (C05.3) |
| `@webtrax/suite-links`, `@webtrax/suite-security` | Check suites | Next (C05.4) |
| `@webtrax/reporters` | Console, JSON, Markdown, HTML | Planned (C05.5) |
| `@webtrax/cli` | `webtrax check`, `webtrax mcp` | Planned (C05.6, C05.7) |

The crawler identifies itself as `Mozilla/5.0 (compatible; WebtraxBot/1.0; +https://webtrax.dev/bot)` and honours `robots.txt` and `Crawl-delay`. See [webtrax.dev/bot](https://webtrax.dev/bot).

Licensed under the [Apache License 2.0](LICENSE).
