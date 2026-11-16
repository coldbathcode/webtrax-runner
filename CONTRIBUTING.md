# Contributing

Thanks for helping. Issues and pull requests are welcome.

- **Before a large change**, open an issue so we can agree on the approach.
- **Setup:** Node.js 22.19+, pnpm 10. `pnpm install`, then `pnpm run check` and `pnpm run build`. Browser tests need Chromium: `pnpm --filter @webtrax/net-proxy exec playwright-core install chromium`.
- **Tests come with changes.** New rules need a fixture page or unit test and an expected finding; behaviour changes to the crawler or network guard need a test that fails without them.
- **Rules** live in the suite packages (`packages/suite-*`) as `RuleMeta` with why and how to fix; docs pages are generated from them.
- **Licence:** contributions are under Apache-2.0 (section 5 of the licence). Add `Signed-off-by:` to your commits (`git commit -s`) to certify the [Developer Certificate of Origin](https://developercertificate.org/).
- **Security issues:** see [SECURITY.md](SECURITY.md), not public issues.
