# @webtrax/cli

The `webtrax` command (C05.6). `src/main.ts` exports `main(argv, io)` (returns the exit code; tests call it directly); `src/bin.ts` wires it to the process (first Ctrl-C → partial report, second → exit 130). `pnpm build` bundles everything under `runner/` into `dist/webtrax.js` with esbuild; third-party packages (undici, cheerio, robots-parser, zod, yaml) stay npm dependencies.

- **Commands:** `check [url]`, `init [url]`, `diff [runA runB]` (defaults to the last two runs), `explain <rule|finding id>`, `doctor`, `--version`, `--help`.
- **check:** flags over `webtrax.yml` over defaults (`src/config.ts`). Runs links, security and seo unless `--suites`. Writes `.webtrax/runs/<time>/run.ndjson` plus `report.html` and `report.md` (`--reports`), prints the console summary (`--stdout md|json` for agents and scripts, `--quiet` for nothing). Private targets are allowed automatically for localhost and private IPs, otherwise only with `--allow-private`.
- **Exit codes:** 0 ok; 1 a finding at or above `--fail-on` (default high); 2 usage/config error; 3 the site could not be crawled. 70 is an unexpected crash.
- Deviation from the CLI doc: report files and stdout are separate flags (`--reports`, `--stdout`) instead of one `--format`, so a hook can print Markdown while the HTML is still written.
- Not yet: `report serve`, `login`/`cloud`, `--changed-since`, `--new-only --baseline`, SARIF/JUnit (C05.11), `explain` with BYOK AI.
- Tests run the fixture site in-process: never use a synchronous spawn against it (it starves the server).
