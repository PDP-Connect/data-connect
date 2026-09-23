#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
archive="${repo_root}/reference-implementation/vendor/pdpp-polyfill-connectors-0.0.1.tgz"
shim_root="${repo_root}/reference-implementation/type-shims"

if [[ ! -f "${archive}" ]]; then
  echo "missing declaration source archive: ${archive}" >&2
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
  # The package has one declaration line with trailing whitespace. Strip only
  # line-end spaces before comparison so the checked-in shim stays clean while
  # CI still proves every declaration token matches the package source.
  if ! diff -u \
    <(tar -xzOf "${archive}" "package/${file}" | sed 's/[[:blank:]]*$//') \
    <(sed 's/[[:blank:]]*$//' "${shim_root}/${file}"); then
    echo "type shim drifted from polyfill-connectors package: ${file}" >&2
    exit 1
  fi
done

echo "polyfill-connectors type shims match ${#files[@]} package declarations"
