#!/usr/bin/env bash
# Builds the runner image from this checkout: builds and packs @webtrax/cli
# into .image/, then docker build (the image installs Chromium with the CLI's
# own playwright-core, so their versions cannot drift). Prove it with
# scripts/image-test.sh.
#
#   scripts/image.sh [tag]        (default webtrax-runner:dev)
#   scripts/image.sh --pack-only  only .image/webtrax-cli.tgz (the image workflow builds with buildx)
set -euo pipefail
cd "$(dirname "$0")/.."
pack_only=false
if [ "${1:-}" = "--pack-only" ]; then pack_only=true; shift; fi
tag=${1:-webtrax-runner:dev}

pnpm --filter @webtrax/cli run build >/dev/null
rm -rf .image && mkdir .image
(cd packages/cli && pnpm pack --pack-destination ../../.image >/dev/null)
mv .image/webtrax-cli-*.tgz .image/webtrax-cli.tgz
if $pack_only; then echo "image: packed .image/webtrax-cli.tgz"; exit 0; fi

docker build --quiet --tag "$tag" . >/dev/null
echo "image: built $tag ($(docker image inspect "$tag" --format '{{.Size}}' | awk '{printf "%.0f MB", $1/1e6}'))"
