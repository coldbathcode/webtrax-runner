# @webtrax/cli

Check a website for broken links, redirect problems, security headers and SEO basics, from your terminal, your CI or your coding agent.

```bash
npx @webtrax/cli check https://your-site.example
npx @webtrax/cli check http://localhost:3000 --stdout md   # Markdown for a coding agent
```

Reports go to `.webtrax/runs/<time>/` (`report.html`, `report.md`, `run.ndjson`). Exit codes: 0 ok, 1 findings at or above `--fail-on` (default high), 2 usage error, 3 site unreachable. `webtrax --help` lists every option; `webtrax init` writes a `webtrax.yml`.

The crawler identifies itself as `WebtraxBot` and honours `robots.txt` and `Crawl-delay` ([webtrax.dev/bot](https://webtrax.dev/bot)). Part of the open source [Webtrax runner](https://webtrax.dev/open-source), Apache-2.0.
