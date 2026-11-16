# @webtrax/suite-security

Passive security suite (C05.4; rebuild/08 `passive` tier). Header checks come from the concierge kit. Rules in `SECURITY_RULES`.

- **Header rules run on the start page only** (one finding per site). Mixed content and insecure forms are per page.
- The only extra request is `ctx.request('http://…')` for the start URL, to see whether HTTP upgrades to HTTPS (a request a browser makes too).
- HTTPS/HSTS rules and the password-over-HTTP rule skip local hosts (`isLocalHost`: localhost, *.localhost, *.local, *.test, IP literals), so `webtrax mcp` on a dev server stays quiet about HTTPS.
- CSP: missing (medium; report-only only → low), unsafe sources in script-src/default-src (`'unsafe-inline'` without nonce/hash, `'unsafe-eval'`, wildcards).
- Not yet: TLS certificate, cookie, vulnerable-JS, DNS/email and security.txt rules (C06.2).
