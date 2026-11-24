# @webtrax/suite-security

Passive security suite (C05.4; rebuild/08 `passive` tier). Header checks come from the concierge kit. Rules in `SECURITY_RULES`.

- **Header rules run on the start page only** (one finding per site). Mixed content and insecure forms are per page.
- Extra requests: `ctx.request('http://…')` for the start URL, to see whether HTTP upgrades to HTTPS (a request a browser makes too), and the takeover watch's one GET per own name aliased to a listed service.
- HTTPS/HSTS rules and the password-over-HTTP rule skip local hosts (`isLocalHost`: localhost, *.localhost, *.local, *.test, IP literals), so `webtrax mcp` on a dev server stays quiet about HTTPS.
- CSP: missing (medium; report-only only → low), unsafe sources in script-src/default-src (`'unsafe-inline'` without nonce/hash, `'unsafe-eval'`, wildcards).
- **Takeover watch (C06.9 slice e, F-A24; `takeoverWatch`):** in `onSite`, skipped for local targets. `onPage` notes the hosts each page loads scripts, stylesheets and frames from (`resources`, 500 hosts at most). `security.takeover.domain_available`: a host used by a script or stylesheet (critical), a frame (high) or a link (medium) whose name does not exist (`ctx.dns`, nxdomain) and whose registrable domain (`registrableDomain`, a short rule, not the public suffix list) the registry says is unregistered (`ctx.registration`, RDAP); one finding per domain at its worst use. Links the crawl reached are not looked up; 300 hosts a run at most. `security.takeover.dangling_cname`: the site's host, its registrable domain and same-domain hosts seen in links or resources whose CNAME chain ends at a service in `TAKEOVER_SERVICES` (the can-i-take-over-xyz entries marked vulnerable) and the target does not exist (`nx` services) or one GET of the name shows the service's "nothing here" text (`says`). Tests in `test/takeover.test.ts` with fake DNS, registry and GET.
- Not yet: TLS certificate, cookie, vulnerable-JS, DNS/email and security.txt rules (C06.2).
