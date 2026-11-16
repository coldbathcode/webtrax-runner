# The Webtrax runner image: @webtrax/cli with Chromium, run as a non-root user.
#
#   scripts/image.sh && docker run --rm webtrax-runner:dev check https://example.com --browser
#
# The base image tag MUST match the playwright-core version the CLI depends on:
# it ships browsers for one Playwright release only (COR-04). scripts/image.sh
# checks it, packs the CLI into .image/ and builds; scripts/image-test.sh proves
# the result (non-root, read-only root filesystem, same findings as outside).
FROM mcr.microsoft.com/playwright:v1.57.0-noble

LABEL org.opencontainers.image.title="Webtrax runner" \
      org.opencontainers.image.description="Website checks: links, security, SEO, accessibility and performance" \
      org.opencontainers.image.source="https://github.com/coldbathcode/webtrax-runner" \
      org.opencontainers.image.licenses="Apache-2.0"

ENV NODE_ENV=production \
    NPM_CONFIG_UPDATE_NOTIFIER=false \
    NPM_CONFIG_FUND=false

COPY .image/webtrax-cli.tgz /tmp/webtrax-cli.tgz
RUN npm install -g --omit=dev --no-audit /tmp/webtrax-cli.tgz \
 && rm /tmp/webtrax-cli.tgz \
 && npm cache clean --force

USER pwuser
WORKDIR /home/pwuser
ENTRYPOINT ["webtrax"]
CMD ["--help"]
