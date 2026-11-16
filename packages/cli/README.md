# @webtrax/cli

Check a website for broken links, redirect problems, security headers, SEO basics, accessibility and performance, from your terminal, your CI or your coding agent.

```bash
npx @webtrax/cli check https://your-site.example
npx @webtrax/cli check https://your-site.example --browser       # adds accessibility (axe) and performance
npx @webtrax/cli check http://localhost:3000 --stdout md          # Markdown for a coding agent
claude mcp add webtrax -- npx -y @webtrax/cli mcp                 # local MCP server for Claude Code
```

Reports go to `.webtrax/runs/<time>/` (`report.html`, `report.md`, `run.ndjson`; `--reports sarif,junit` for code scanning and CI dashboards). Exit codes: 0 ok, 1 findings at or above `--fail-on` (default high), 2 usage error, 3 site unreachable. Needs Node.js 22.19+; `--browser` also needs Chromium (`npx playwright@1.57.0 install chromium`) or Google Chrome.

**Docs:** https://docs.webtrax.dev/ · **Rules:** https://docs.webtrax.dev/rules/ · **Source:** https://github.com/coldbathcode/webtrax-runner

The crawler identifies itself as `WebtraxBot`, honours `robots.txt` and `Crawl-delay`, and never reaches private networks or cloud metadata unless you allow it ([webtrax.dev/bot](https://webtrax.dev/bot)). Apache-2.0.
