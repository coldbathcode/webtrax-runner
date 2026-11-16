# runner/ (open source, Apache-2.0)

The Webtrax runner, CLI and local MCP server (MASTER_PLAN C05). Built inside this monorepo until the alpha, then split out to `coldbathcode/webtrax-runner` with its history (ADR 0010, D16). The ordered steps, with what to read and "done when", are in [`plan/BUILD-PLAN.md`](../plan/BUILD-PLAN.md) Phase 1; status is in `TRACKER.md`.

- **Imports nothing outside `runner/`:** no cloud package (`@webtrax/domain`, `@webtrax/db`, `@webtrax/config` …), no relative path, tsconfig or file read that climbs out. `test/independence.test.ts` enforces it. Shared things the cloud also needs (protocol, bot identity) live here and the cloud imports them.
- **Own toolchain:** `tsconfig.base.json` and `eslint.base.js` here; packages extend `../../tsconfig.base.json` and use `runner()` from `../../eslint.base.js`. Every `package.json` says `"license": "Apache-2.0"` (tested).
- **Packages:** `packages/<name>`, published as `@webtrax/<name>` at the alpha. They stay `"private": true` until C05.9. The executor is `@webtrax/engine` (`@webtrax/core` is the cloud's).
- **Behaviour reference:** v1's crawler in `apps/legacy/runner/lib/` (`crawl-core.js`, `address.js`, `guarded-fetch.js`) and its tests. Port semantics exactly unless the plan says otherwise.
- **Commands:** `pnpm --filter './runner/**' test`, or `pnpm run check` at the root (the pre-push hook) which includes these packages.
