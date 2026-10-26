#!/usr/bin/env bash
# Copyright The PDP-Connect Contributors
# SPDX-License-Identifier: Apache-2.0

set -euo pipefail

image="${PDPP_CORE_ORACLE_IMAGE:-pdpp-core-headed-oracle}"
# CI reuses the already-built core target, exactly as the headed oracle does.
if [ "${PDPP_CORE_ORACLE_SKIP_BUILD:-0}" != "1" ]; then
  docker build --target core --tag "$image" .
fi

# Override the application entrypoint: the default path must never launch a
# browser, start the server, or have network access. The image supplies both the
# scanner and the binary, rather than mixing a host checkout with image bytes.
status=0
docker run --rm --log-driver none --network none --entrypoint node \
  "$image" --import tsx /app/scripts/browser-trust-oracle.ts binary || status=$?

# Explicit qualification only. Still run probes when a hold has resolved so
# callers can capture both results; the stale-hold failure remains nonzero.
if [ "${PDPP_BROWSER_TRUST_PROBE:-0}" = "1" ]; then
  for mode in compiled as-launched; do
    docker run --rm --log-driver none --entrypoint xvfb-run \
      -e PDPP_BROWSER_TRUST_PROBE=1 \
      -e PDPP_BROWSER_TRUST_REJECT_URLS \
      -e PDPP_BROWSER_TRUST_CONTROL_URL \
      "$image" -a node --import tsx /app/scripts/browser-trust-oracle.ts first-navigation --mode "$mode" || status=$?
  done
fi
exit "$status"
