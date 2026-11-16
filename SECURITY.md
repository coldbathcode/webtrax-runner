# Security

Please report vulnerabilities privately to **security@webtrax.dev**, not in a public issue. Include what you found, how to reproduce it, and which version (`webtrax --version`). We acknowledge reports within three working days and keep you updated until a fix ships.

The runner fetches URLs other people control, so its network guard matters most: it must never reach private networks, loopback or cloud metadata unless the user allowed it, across redirects, DNS rebinding and the browser stage. Reports about bypassing that are especially welcome.
