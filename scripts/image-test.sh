#!/usr/bin/env bash
# Proves a runner image: it reports the CLI's version, runs as a non-root
# user, and a --browser check of the fixture site inside it (read-only root
# filesystem, only /tmp writable) gives the same findings as the CLI outside.
#
#   scripts/image-test.sh [tag]   (default webtrax-runner:dev)
set -euo pipefail
cd "$(dirname "$0")/.."
tag=${1:-webtrax-runner:dev}
fail() { echo "image-test: $*"; exit 1; }

want=$(node -p "require('./packages/cli/package.json').version")
got=$(docker run --rm "$tag" --version)
[ "$got" = "$want" ] || fail "version $got, expected $want"
uid=$(docker run --rm --entrypoint id "$tag" -u)
[ "$uid" != 0 ] || fail "runs as root"

# Findings as "severity rule path", sorted: the origin's port differs between runs.
# Site-wide findings (no llms.txt, no structured data) have no URL.
summarise='let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const r=JSON.parse(s);console.log(r.findings.map(f=>`${f.severity} ${f.rule_id} ${f.url?new URL(f.url).pathname:"(site)"}`).sort().join("\n"))})'
check='webtrax check "$(head -1 /tmp/origin)" --browser --fail-on none --out /tmp/out --stdout json'

inside=$(docker run --rm --read-only --tmpfs /tmp --network none \
  -v "$PWD/fixtures:/fixtures:ro" --entrypoint sh "$tag" -c \
  "node /fixtures/site/serve.mjs > /tmp/origin & for i in \$(seq 1 40); do [ -s /tmp/origin ] && break; sleep 0.25; done; $check" \
  | node -e "$summarise")

tmp=$(mktemp -d)
node fixtures/site/serve.mjs > "$tmp/origin" & server=$!
trap 'kill $server 2>/dev/null; rm -rf "$tmp"' EXIT
for _ in $(seq 1 40); do [ -s "$tmp/origin" ] && break; sleep 0.25; done
outside=$(node packages/cli/dist/webtrax.js check "$(head -1 "$tmp/origin")" --browser --fail-on none --out "$tmp/out" --stdout json | node -e "$summarise")

[ -n "$inside" ] || fail "no findings inside the image (the fixture has known findings)"
if [ "$inside" != "$outside" ]; then
  diff <(echo "$outside") <(echo "$inside") || true
  fail "findings differ between the CLI (left) and the image (right)"
fi
echo "image-test: ok ($tag: version $got, uid $uid, $(echo "$inside" | wc -l | tr -d ' ') findings, same as outside, read-only root, no network)"
