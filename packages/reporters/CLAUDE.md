# @webtrax/reporters

Reports for a run (C05.5), all rendered from the protocol records (`buildReport(records, rules)`), so a report can be rebuilt later from a run's `run.ndjson`.

- **Model:** findings grouped by fingerprint (one entry per problem, every source page listed), sorted by severity, rule, URL; short id = first 10 characters of the fingerprint (shown to people and agents). Rule metadata (why/fix/docs) comes from the suites' `RuleMeta`.
- **Formats:** `renderConsole` (plain; colour only adds ANSI codes), `renderJson`, `renderNdjson`, `renderMarkdown` (stable headings, for PR comments and pasting into an LLM; Markdown-escaped), `renderHtml` (single file, offline, no script, light/dark, escaped; only http(s) values become links).
- **Tests:** golden files in `test/golden/` from the fixed run in `test/sample.ts` (`UPDATE_GOLDEN=1` to regenerate; review the diff). The HTML is checked with axe (WCAG 2.2 AA + best practice) in Chromium, light and dark, every finding expanded, and must make no network requests. CI installs Chromium before the package tests for this.
- SARIF and JUnit come with C05.11.
