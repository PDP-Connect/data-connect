#!/usr/bin/env bash
# Copyright The PDP-Connect Contributors
# SPDX-License-Identifier: Apache-2.0

# Fill empty secrets in a Docker Compose env file without displaying them.
set -euo pipefail

if [[ "${1:-}" != "--write" || $# -gt 2 ]]; then
  echo "Usage: bash generate-secrets.sh --write [ENV_FILE]" >&2
  exit 2
fi

target="${2:-.env}"
if [[ ! -f "$target" ]]; then
  echo "Env file not found: $target" >&2
  exit 1
fi
if ! command -v openssl >/dev/null 2>&1; then
  echo "OpenSSL is required to generate secrets." >&2
  exit 1
fi

# Compose substitutes these values into Core and Postgres. Hex avoids URL
# escaping for the Postgres password embedded in PDPP_DATABASE_URL.
fill_empty() {
  local key="$1" bytes="$2" value temp
  if grep -qE "^${key}=[^[:space:]]" "$target"; then
    printf 'preserved %s\n' "$key"
    return
  fi
  value="$(openssl rand -hex "$bytes")"
  temp="$(mktemp "${target}.XXXXXX")"
  awk -v key="$key" -v value="$value" '
    $0 ~ "^" key "=" {
      if ($0 ~ "^" key "=[[:space:]]*$") print key "=" value
      else print
      found = 1
      next
    }
    { print }
    END { if (!found) print key "=" value }
  ' "$target" > "$temp"
  chmod 600 "$temp"
  mv "$temp" "$target"
  printf 'set %s\n' "$key"
}

chmod go-rwx "$target"
fill_empty PDPP_CREDENTIAL_ENCRYPTION_KEY 32
fill_empty PDPP_POSTGRES_PASSWORD 24
printf 'Secrets saved in %s. Keep this file out of version control.\n' "$target"
