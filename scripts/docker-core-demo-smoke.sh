#!/usr/bin/env bash
# Copyright The PDP-Connect Contributors
# SPDX-License-Identifier: Apache-2.0
set -euo pipefail

REPOSITORY_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
IMAGE="${PDPP_CORE_SMOKE_IMAGE:-pdpp:ci-core-test}"
IMAGE_BUILD="${PDPP_CORE_SMOKE_SKIP_BUILD:-0}"
RUN_ID="$(date +%s)-$$"
NAME="pdpp-core-demo-${RUN_ID}"
NETWORK="${NAME}-network"
VOLUME="${NAME}-data"
TUNNEL_HOST="${PDPP_CORE_SMOKE_TUNNEL_HOST:-pdpp-demo-${RUN_ID}.test}"
SMOKE_PORT="${PDPP_CORE_SMOKE_PORT:-7662}"
ORIGIN="https://${TUNNEL_HOST}"
# Core's CIMD fetch refuses addresses that the IANA special-purpose registry
# does not mark globally reachable, so a normal private Docker subnet is
# refused. AMT (192.52.193.0/24, RFC 7450) is registry-marked globally
# reachable, and Core never contacts AMT relays. Using a small block of it on
# this disposable network lets Core fetch the CIMD fixture from this checkout
# through the unchanged production guard.
CIMD_HOST="cimd.pdpp-smoke.test"
NETWORK_SUBNET="${PDPP_CORE_SMOKE_SUBNET:-192.52.193.240/28}"
TEMP_ROOT="${HOME}/.tmp/pdpp-core-demo-${RUN_ID}"
OWNER_PASSWORD="$(node -e 'process.stdout.write(require("node:crypto").randomBytes(24).toString("base64url"))')"

CORE_CONTAINER="${NAME}"
PROXY_CONTAINER="${NAME}-tunnel"

cleanup() {
  local exit_code=$?
  trap - EXIT
  if (( exit_code != 0 )); then
    echo "docker-core-demo-smoke: Core logs before cleanup:" >&2
    docker logs --tail=100 "$CORE_CONTAINER" 2>&1 | sed -E 's/(setupToken["=: ]+)[^ ,"]+/\1[redacted]/g' >&2 || true
  fi
  docker rm -f "$PROXY_CONTAINER" "$CORE_CONTAINER" >/dev/null 2>&1 || true
  docker network rm "$NETWORK" >/dev/null 2>&1 || true
  docker volume rm "$VOLUME" >/dev/null 2>&1 || true
  rm -rf "$TEMP_ROOT"
  exit "$exit_code"
}
trap cleanup EXIT

require_command() {
  command -v "$1" >/dev/null 2>&1 || { echo "docker-core-demo-smoke: missing command: $1" >&2; exit 127; }
}

wait_for_setup_token() {
  local started_at
  started_at="$(date +%s)"
  while (( $(date +%s) - started_at < 180 )); do
    if [[ "$(docker inspect --format '{{.State.Running}}' "$CORE_CONTAINER" 2>/dev/null || true)" != "true" ]]; then
      echo "docker-core-demo-smoke: Core container exited before setup token was ready" >&2
      docker logs --tail=100 "$CORE_CONTAINER" 2>&1 | sed -E 's/(setupToken["=: ]+)[^ ,"]+/\1[redacted]/g' >&2 || true
      return 1
    fi
    local token
    token="$(docker logs "$CORE_CONTAINER" 2>&1 | sed -n 's/.*"setupToken":"\([^"]*\)".*/\1/p' | tail -n 1)"
    if [[ -n "$token" ]]; then
      printf '%s' "$token"
      return 0
    fi
    sleep 2
  done
  echo "docker-core-demo-smoke: timed out waiting for setup token" >&2
  docker logs --tail=80 "$CORE_CONTAINER" 2>&1 | sed -E 's/(setupToken["=: ]+)[^ ,"]+/\1[redacted]/g' >&2 || true
  return 1
}

require_command docker
require_command node
require_command openssl
mkdir -p "$TEMP_ROOT"

free_kb="$(df -Pk "$TEMP_ROOT" | awk 'NR == 2 { print $4 }')"
if (( free_kb < 30 * 1024 * 1024 )); then
  echo "docker-core-demo-smoke: requires at least 30 GiB free; found $((free_kb / 1024 / 1024)) GiB" >&2
  exit 1
fi

if [[ "$IMAGE_BUILD" != "1" ]]; then
  revision="$(git -C "$REPOSITORY_ROOT" rev-parse HEAD)"
  docker build --target core --build-arg "PDPP_REFERENCE_REVISION=$revision" --tag "$IMAGE" "$REPOSITORY_ROOT"
fi

docker network create --ipv6=false --subnet "$NETWORK_SUBNET" "$NETWORK" >/dev/null || { echo "docker-core-demo-smoke: cannot create $NETWORK_SUBNET; remove a leftover pdpp-core-demo-*-network or set PDPP_CORE_SMOKE_SUBNET" >&2; exit 1; }
docker volume create "$VOLUME" >/dev/null
openssl req -x509 -newkey rsa:2048 -nodes -keyout "$TEMP_ROOT/tunnel.key" -out "$TEMP_ROOT/tunnel.crt" -days 1 -subj "/CN=$TUNNEL_HOST" -addext "subjectAltName=DNS:$TUNNEL_HOST,DNS:$CIMD_HOST" >/dev/null 2>&1
cat >"$TEMP_ROOT/nginx.conf" <<'NGINX'
events {}
http {
  server {
    listen 443 ssl;
    server_name cimd.pdpp-smoke.test;
    ssl_certificate /etc/nginx/tunnel.crt;
    ssl_certificate_key /etc/nginx/tunnel.key;
    location = /docker-core-smoke-cimd.json {
      default_type application/json;
      alias /srv/cimd/docker-core-smoke-cimd.json;
    }
  }
  server {
    listen 443 ssl default_server;
    server_name _;
    ssl_certificate /etc/nginx/tunnel.crt;
    ssl_certificate_key /etc/nginx/tunnel.key;
    location / {
      proxy_pass http://core:3000;
      proxy_set_header Host $host;
      proxy_set_header X-Forwarded-Host $host;
      proxy_set_header X-Forwarded-Proto https;
      proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    }
  }
}
NGINX

docker run --detach --name "$CORE_CONTAINER" \
  --network "$NETWORK" --network-alias core \
  --publish "127.0.0.1:${SMOKE_PORT}:3000" \
  --env PDPP_BIND_HOST=0.0.0.0 \
  --env "PDPP_REFERENCE_ORIGIN=$ORIGIN" \
  --env "PDPP_TRUSTED_HOSTS=localhost,127.0.0.1,$TUNNEL_HOST" \
  --env "PDPP_CORE_SMOKE_OWNER_PASSWORD=$OWNER_PASSWORD" \
  --env NODE_EXTRA_CA_CERTS=/run/secrets/tunnel.crt \
  --volume "$VOLUME:/var/lib/pdpp" \
  --volume "$TEMP_ROOT/tunnel.crt:/run/secrets/tunnel.crt:ro" \
  "$IMAGE" >/dev/null

# The disposable TLS ingress stands in for the public Cloudflare tunnel. It
# forwards to the Core container on the same private network; the Core run
# command above keeps the documented tunnel origin and trusted-host settings.
docker run --detach --name "$PROXY_CONTAINER" \
  --network "$NETWORK" --network-alias "$TUNNEL_HOST" --network-alias "$CIMD_HOST" \
  --volume "$TEMP_ROOT/nginx.conf:/etc/nginx/nginx.conf:ro" \
  --volume "$TEMP_ROOT/tunnel.crt:/etc/nginx/tunnel.crt:ro" \
  --volume "$TEMP_ROOT/tunnel.key:/etc/nginx/tunnel.key:ro" \
  --volume "$REPOSITORY_ROOT/scripts/fixtures/docker-core-smoke-cimd.json:/srv/cimd/docker-core-smoke-cimd.json:ro" \
  nginx:1.29-alpine >/dev/null

setup_token="$(wait_for_setup_token)"
# The helper lives in /app so ESM resolves the image's own Patchright package.
docker cp "$REPOSITORY_ROOT/scripts/docker-core-demo-smoke-browser.mjs" "$CORE_CONTAINER:/app/scripts/docker-core-demo-smoke-browser.mjs"
docker cp "$REPOSITORY_ROOT/scripts/fixtures/docker-core-smoke-private-key.pem" "$CORE_CONTAINER:/app/scripts/fixtures/docker-core-smoke-private-key.pem"
docker exec \
  --env "PDPP_CORE_SMOKE_ORIGIN=$ORIGIN" \
  --env "PDPP_CORE_SMOKE_SETUP_TOKEN=$setup_token" \
  --env "PDPP_CORE_SMOKE_OWNER_PASSWORD=$OWNER_PASSWORD" \
  --env PDPP_DATA_DIR=/var/lib/pdpp \
  --workdir /app \
  "$CORE_CONTAINER" node --import tsx scripts/docker-core-demo-smoke-browser.mjs
