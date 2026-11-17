# The Webtrax runner image: @webtrax/cli with Chromium, run as a non-root user.
#
#   scripts/image.sh && docker run --rm webtrax-runner:dev check https://example.com --browser
#
# Slim on purpose (H7): Node on Debian slim plus only Chromium's headless shell,
# which is what chromium.launch() uses headless. The full Playwright image
# carries three browsers and headed Chromium (about 3.6 GB on disk; this is
# about a fifth of that). The browser is installed by the CLI's own
# playwright-core, so the two always match (COR-04). scripts/image-test.sh
# proves the result (non-root, read-only root filesystem, same findings as
# outside).
FROM node:22-bookworm-slim

LABEL org.opencontainers.image.title="Webtrax runner" \
      org.opencontainers.image.description="Website checks: links, security, SEO, accessibility and performance" \
      org.opencontainers.image.source="https://github.com/coldbathcode/webtrax-runner" \
      org.opencontainers.image.licenses="Apache-2.0"

ENV NODE_ENV=production \
    NPM_CONFIG_UPDATE_NOTIFIER=false \
    NPM_CONFIG_FUND=false \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

COPY .image/webtrax-cli.tgz /tmp/webtrax-cli.tgz
RUN npm install -g --omit=dev --no-audit /tmp/webtrax-cli.tgz \
 && rm /tmp/webtrax-cli.tgz \
 && pw="$(npm root -g)/@webtrax/cli/node_modules/playwright-core/cli.js" \
 && node "$pw" install --with-deps --only-shell chromium \
 && rm -rf /var/lib/apt/lists/* /root/.cache /tmp/* \
 && npm cache clean --force \
 && useradd --create-home --uid 1001 webtrax

USER webtrax
WORKDIR /home/webtrax
ENTRYPOINT ["webtrax"]
CMD ["--help"]
