# @webtrax/net-guard

Scope policy and guarded fetch (C05.2): the only way runner code may make an HTTP request to a target site. Port of v1 `apps/legacy/runner/lib/address.js` and `guarded-fetch.js`, with every v1 test, plus a scope policy.

- `ScopePolicy` (`src/policy.ts`) decides per URL and per resolved address. First match wins: metadata always refused → `deny` hosts/CIDRs → `allow` hosts/CIDRs → private needs `allowPrivate` → public needs `publicInternet` (default on). Default = v1: public internet only.
- `allowPrivate` is for local development and `webtrax mcp`. Unlike v1 it does not switch the guard off: cloud metadata (`METADATA_ADDRESSES`) stays unreachable in every mode.
- `createGuardedFetch` checks the URL, connects through `createGuardedLookup` (the address checked is the address used, so DNS rebinding fails; a mixed public/private answer is refused), and follows redirects by hand, checking every hop. Returns `{ response, url, chain }`; the chain feeds `PageRecord.redirect_chain`. Refusals throw `ScopeDeniedError` (`code: 'EBLOCKED'`, `reason`, `target`).
- **Origin headers:** `originHeaders: {origin, headers}` on a guarded fetch adds those headers only on hops whose origin matches `origin`, or one of a list of origins (`onOrigin`) (a protected preview's bypass secret, a site's firewall pass, the job's `auth.headers`); a redirect to another host never carries them, and a redirect back does again. Tested with real sockets, mutation-checked.
- `readBodyCapped` / `readTextCapped` cap decoded bytes (default 5 MB, COR-11), so compressed bombs are cut off too. `discardBody` for responses you don't read.
- **Never call `fetch` or `undici` directly elsewhere in the runner.** The browser stage (C05.10) goes through an egress proxy built on this policy.
- Tests use real sockets on 127.0.0.1 with an injected lookup; `site.test` is allowed by CIDR to play a public site. Safety rules are mutation-checked: if you change one, make sure a test fails when you break it.
