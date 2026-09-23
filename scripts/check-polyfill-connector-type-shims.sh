#!/usr/bin/env bash
# Copyright The PDP-Connect Contributors
# SPDX-License-Identifier: Apache-2.0

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
archive="${repo_root}/reference-implementation/vendor/pdpp-polyfill-connectors-0.0.1.tgz"
shim_root="${repo_root}/reference-implementation/type-shims"

if [[ ! -f "${archive}" ]]; then
  echo "missing declaration source archive: ${archive}" >&2
  exit 1
fi

if ! tar -tzf "${archive}" >/dev/null; then
  echo "invalid declaration source archive: ${archive}" >&2
  exit 1
fi

files=(
  src/manual-upload-validation.d.ts
  src/local-source-inventory.d.ts
  src/connector-runtime.d.ts
  src/fingerprint-cursor.d.ts
  connectors/apple_health/validation.d.ts
  connectors/google_maps/validation.d.ts
  connectors/google_maps/types.d.ts
  connectors/netflix_export/validation.d.ts
  connectors/netflix_export/types.d.ts
  connectors/strava/validation.d.ts
  connectors/whatsapp/validation.d.ts
)

for file in "${files[@]}"; do
  if ! tar -tzf "${archive}" "package/${file}" | grep -Fxq "package/${file}"; then
    echo "missing package declaration: ${file}" >&2
    exit 1
  fi
  if [[ ! -f "${shim_root}/${file}" ]]; then
    echo "missing checked-in type shim: ${file}" >&2
    exit 1
  fi

  # The shim has the required repository SPDX header. Skip only that header and
  # line-end spaces so CI compares every declaration token with package source.
  if ! diff -u \
    <(tar -xzOf "${archive}" "package/${file}" | sed 's/[[:blank:]]*$//') \
    <(sed -e '1,3d' -e 's/[[:blank:]]*$//' "${shim_root}/${file}"); then
    echo "type shim drifted from polyfill-connectors package: ${file}" >&2
    exit 1
  fi
done

echo "polyfill-connectors type shims match ${#files[@]} package declarations"
