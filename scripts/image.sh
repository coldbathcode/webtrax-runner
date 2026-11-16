#!/usr/bin/env bash
# Builds the runner image from this checkout: checks the base image matches
# the CLI's playwright-core, builds and packs @webtrax/cli into .image/, then
# docker build. Prove it with scripts/image-test.sh.
#
#   scripts/image.sh [tag]        (default webtrax-runner:dev)
set -euo pipefail
cd "$(dirname "$0")/.."
tag=${1:-webtrax-runner:dev}

pw=$(node -p "require('./packages/cli/package.json').dependencies['playwright-core']")
grep -q "playwright:v${pw}-" Dockerfile || { echo "image: the Dockerfile's base image does not match playwright-core ${pw}"; exit 1; }

pnpm --filter @webtrax/cli run build >/dev/null
rm -rf .image && mkdir .image
(cd packages/cli && pnpm pack --pack-destination ../../.image >/dev/null)
mv .image/webtrax-cli-*.tgz .image/webtrax-cli.tgz

docker build --quiet --tag "$tag" . >/dev/null
echo "image: built $tag ($(docker image inspect "$tag" --format '{{.Size}}' | awk '{printf "%.0f MB", $1/1e6}'))"
