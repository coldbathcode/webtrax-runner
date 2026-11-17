#!/usr/bin/env bash
# Builds the runner image from this checkout: builds and packs @webtrax/cli
# into .image/, then docker build (the image installs Chromium with the CLI's
# own playwright-core, so their versions cannot drift). Prove it with
# scripts/image-test.sh.
#
#   scripts/image.sh [tag]        (default webtrax-runner:dev)
set -euo pipefail
cd "$(dirname "$0")/.."
tag=${1:-webtrax-runner:dev}

pnpm --filter @webtrax/cli run build >/dev/null
rm -rf .image && mkdir .image
(cd packages/cli && pnpm pack --pack-destination ../../.image >/dev/null)
mv .image/webtrax-cli-*.tgz .image/webtrax-cli.tgz

docker build --quiet --tag "$tag" . >/dev/null
echo "image: built $tag ($(docker image inspect "$tag" --format '{{.Size}}' | awk '{printf "%.0f MB", $1/1e6}'))"
