# @webtrax/net-proxy

Egress proxy for the browser stage (C05.10, SEC-03). `startEgressProxy({ policy })` listens on 127.0.0.1; `chromiumProxyArgs(url)` are the flags the browser stage launches Chromium with: all traffic through the proxy, loopback included (`--proxy-bypass-list=<-loopback>`), no name resolution in Chromium (`--host-resolver-rules=MAP * ~NOTFOUND`), no direct WebRTC UDP, no QUIC.

- CONNECT (HTTPS and WebSockets) and plain-HTTP requests are both checked: the proxy resolves the name, checks **every** answer with the same `ScopePolicy` as `@webtrax/net-guard` (so cloud metadata is always refused), and connects to the address it checked. Rebinding and mixed answers fail.
- `allowedPorts` limits which ports a page may reach; `refused` records every refusal (target and reason).
- Tests drive raw CONNECT/HTTP and a real Chromium (playwright-core): a page that tries to load a private address and the metadata endpoint still renders, and both are refused. Rules are mutation-checked.
