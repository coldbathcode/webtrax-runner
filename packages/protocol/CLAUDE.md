# @webtrax/protocol

The runner protocol (C05.1): one definition of every record a run produces and the job spec that starts it. Apache-2.0; part of the open source runner (`runner/`, ADR 0010), consumed by the cloud for ingest (C04.5).

- `src/schemas.ts`: Zod schemas and types: `JobSpec`, `RuleMeta`, and the NDJSON `RunLine` union (`run`, `page`, `finding`, `metric`, `snapshot`, `artifact`, `summary`). snake_case on the wire, like the database.
- `src/enums.ts`: suites, severities, run statuses, fetch and run errors. `suite` and `severity` must match the database enums in `packages/db/migrations/0001_baseline.sql` (a cloud-side test, `packages/db/test/protocol.test.ts`, reads the migration; the runner never reads files outside `runner/`).
- `src/fingerprint.ts`: `fingerprint(ruleId, url, evidenceKey)`, sha256 over the normalised URL (Web Crypto, async). Never put timings or ordering in the key.
- `src/url.ts`: `normaliseUrl`, with v1's semantics (fragment dropped, trailing slash removed except at the root).
- `src/bot.ts`: the WebtraxBot identity. No imports: v1 imports this file by path. `@webtrax/domain/bot` re-exports it.
- `schema/*.json`: JSON Schema generated from the Zod schemas. After changing a schema run `pnpm gen:schema`; a test fails on drift.
- **Changing a record:** additive changes only (new optional fields). A breaking change needs `PROTOCOL_VERSION` bumped and a note in the plan.
- Stays `"private": true` until the alpha release (C05.9) publishes it to npm.
