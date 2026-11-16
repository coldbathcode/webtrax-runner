# Webtrax check (GitHub Action)

Checks a site, typically each preview deploy, and fails the job when something is broken.

```yaml
on: deployment_status
jobs:
  webtrax:
    if: github.event.deployment_status.state == 'success'
    runs-on: ubuntu-latest
    permissions:
      security-events: write
    steps:
      - id: webtrax
        uses: coldbathcode/webtrax-runner/action@v1
        with:
          url: ${{ github.event.deployment_status.environment_url }}
          fail-on: high
      - uses: github/codeql-action/upload-sarif@v3
        if: always()
        with:
          sarif_file: ${{ steps.webtrax.outputs.sarif-file }}
          category: webtrax
```

Inputs: `url` (required), `fail-on` (default `high`), `browser` (`true` adds accessibility and performance; installs Chromium), `max-pages`, `suites`, `args` (extra CLI options), `summary` (Markdown report in the job summary, default on), `version` (of `@webtrax/cli`). Outputs: `exit-code`, `report-dir`, `sarif-file`. Docs: https://docs.webtrax.dev/ci/
