#!/usr/bin/env bash
# Copyright The PDP-Connect Contributors
# SPDX-License-Identifier: Apache-2.0
#
# Proves every browser in a built image loads docker/chrome-policy/
# distrusted-cas.json as machine policy.
#
# Chromium reads machine policy from a directory chosen by its branding, so a
# file at the wrong path is silently ignored. This script therefore checks the
# browser, not only the file: it starts each browser binary in the image
# headless, reads chrome://policy over the DevTools Protocol from a sidecar
# Node container, and requires CADistrustedCertificates to equal the
# repository file (deploy/docker/check-chrome-policy-page.mjs). Every
# installed copy of the file must also be root-owned, mode 0644 and
# byte-identical to the repository file. The container gets no network,
# credentials, profile or display, and is removed on exit.
#
# A managed URLBlocklist can block chrome://policy itself (n.eko's
# docker/neko/policies.json does). In the throwaway container only, the
# script removes chrome://policy entries from every other policy file's
# URLBlocklist so each browser's values can be read; no other policy changes.
# Every browser must then show the expected value.
#
# Chrome Headless Shell (Patchright's chromium_headless_shell build) does not
# read managed policy at all, so an image that ships it fails the check.
#
# Usage:
#   check-chrome-distrust-policy.sh <image-ref>
#
# Env:
#   PDPP_POLICY_CHECK_NODE_IMAGE  Node image for the DevTools client
#                                 (default: the Node image docker/neko/Dockerfile pins)
#
# Exit codes:
#   0  every browser in the image reports the expected policy
#   1  a browser does not report it, an installed file is wrong, or the image
#      ships Chrome Headless Shell
#   2  usage error

set -euo pipefail

if [ "$#" -ne 1 ]; then
  echo "usage: $0 <image-ref>" >&2
  exit 2
fi
IMAGE="$1"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
POLICY="$REPO_ROOT/docker/chrome-policy/distrusted-cas.json"
PAGE_CHECK="$REPO_ROOT/deploy/docker/check-chrome-policy-page.mjs"
NODE_IMAGE="${PDPP_POLICY_CHECK_NODE_IMAGE:-node:24.19.0-bookworm-slim@sha256:3638d9a6fe4030bd716be989438248074489337ba3275657f93595428be4fc03}"
INSTALLED_NAME=pdpp-distrusted-cas.json
CONTAINER="pdpp-policy-check-$$"
CLIENT="pdpp-policy-check-client-$$"
MANAGED_DIRS="/etc/opt/chrome_for_testing/policies/managed /etc/opt/chrome/policies/managed /etc/chromium/policies/managed"
WORK="$(mktemp -d)"

cleanup() {
  docker rm -f "$CONTAINER" "$CLIENT" >/dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap cleanup EXIT

docker run -d --name "$CONTAINER" --network none --entrypoint /bin/sh "$IMAGE" -c 'sleep 600' >/dev/null

failures=0
expected_sha="$(sha256sum "$POLICY" | cut -d' ' -f1)"
installed=""
other_policies=""
for dir in $MANAGED_DIRS; do
  for file in $(docker exec "$CONTAINER" sh -c "ls -1 $dir/*.json 2>/dev/null" || true); do
    if [ "$(basename "$file")" = "$INSTALLED_NAME" ]; then
      installed="$installed $file"
    else
      other_policies="$other_policies $file"
    fi
  done
done
if [ -z "$installed" ]; then
  echo "$IMAGE: no $INSTALLED_NAME in any managed policy directory" >&2
  failures=$((failures + 1))
fi
for file in $installed; do
  meta="$(docker exec "$CONTAINER" stat -c '%U:%G %a' "$file")"
  sha="$(docker exec "$CONTAINER" sha256sum "$file" | cut -d' ' -f1)"
  if [ "$meta" != "root:root 644" ] || [ "$sha" != "$expected_sha" ]; then
    echo "$IMAGE: $file is '$meta' sha256 $sha; want 'root:root 644' sha256 $expected_sha" >&2
    failures=$((failures + 1))
  else
    echo "$IMAGE: $file root:root 644, matches the repository file"
  fi
done

shells="$(docker exec "$CONTAINER" sh -c 'for b in /opt/patchright-browsers/chromium_headless_shell-*/*/chrome-headless-shell; do if [ -e "$b" ]; then echo "$b"; fi; done')"
if [ -n "$shells" ]; then
  echo "$IMAGE: ships Chrome Headless Shell, which ignores managed policy: $shells" >&2
  failures=$((failures + 1))
fi

# Unblock chrome://policy in this throwaway container only.
for file in $other_policies; do
  docker exec "$CONTAINER" cat "$file" >"$WORK/in.json"
  docker run --rm -i "$NODE_IMAGE" node -e '
    let raw = "";
    process.stdin.on("data", (chunk) => (raw += chunk));
    process.stdin.on("end", () => {
      const policy = JSON.parse(raw);
      if (Array.isArray(policy.URLBlocklist)) {
        policy.URLBlocklist = policy.URLBlocklist.filter((entry) => !entry.startsWith("chrome://policy"));
      }
      process.stdout.write(JSON.stringify(policy));
    });' <"$WORK/in.json" >"$WORK/out.json"
  docker exec -i -u 0 "$CONTAINER" sh -c 'cat > "$1"' sh "$file" <"$WORK/out.json"
done

browsers="$(docker exec "$CONTAINER" sh -c 'for b in /opt/patchright-browsers/chromium-*/chrome-linux*/chrome /usr/bin/google-chrome-stable /usr/bin/chromium; do if [ -x "$b" ]; then echo "$b"; fi; done')"
if [ -z "$browsers" ]; then
  echo "$IMAGE: no browser binary found" >&2
  exit 1
fi

port=9330
for browser in $browsers; do
  docker exec -d "$CONTAINER" "$browser" --headless=new --no-sandbox --disable-gpu \
    --user-data-dir="/tmp/pdpp-policy-check-$port" \
    --remote-debugging-address=127.0.0.1 --remote-debugging-port="$port" about:blank
  status=0
  docker run --rm --name "$CLIENT" --network "container:$CONTAINER" \
    -v "$PAGE_CHECK:/check/check-chrome-policy-page.mjs:ro" \
    -v "$POLICY:/check/expected.json:ro" \
    "$NODE_IMAGE" node /check/check-chrome-policy-page.mjs "$port" /check/expected.json "$IMAGE $browser" || status=$?
  if [ "$status" -ne 0 ]; then
    failures=$((failures + 1))
  fi
  port=$((port + 1))
done

if [ "$failures" -ne 0 ]; then
  echo "$IMAGE: $failures CA distrust policy check(s) failed" >&2
  exit 1
fi
