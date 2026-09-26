#!/usr/bin/env bash
# Copyright The PDP-Connect Contributors
# SPDX-License-Identifier: Apache-2.0
#
# Tests for deploy/docker/check-image-secrets.sh
#
# The path rule is tested through `paths` mode (no Docker). The image mode is
# tested with a `docker` stub on PATH that serves a hand-built `docker save`
# archive, or fails, so this never touches the Docker daemon.
#
# Run: bash deploy/docker/check-image-secrets.test.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
TARGET_SCRIPT="$SCRIPT_DIR/check-image-secrets.sh"

pass() { echo "PASS: $*"; }
fail() { echo "FAIL: $*" >&2; FAILURES=$((FAILURES + 1)); }

FAILURES=0

WORK_DIR="$(mktemp -d)"
cleanup() { rm -rf "$WORK_DIR"; }
trap cleanup EXIT

expect_flagged() {
  if printf '%s\n' "$1" | bash "$TARGET_SCRIPT" paths >/dev/null; then
    fail "expected $1 to be flagged"
  else
    pass "flags $1"
  fi
}

expect_allowed() {
  if printf '%s\n' "$1" | bash "$TARGET_SCRIPT" paths >/dev/null; then
    pass "allows $1"
  else
    fail "expected $1 to be allowed"
  fi
}

expect_flagged "app/.env.docker"
expect_flagged "app/.env"
expect_flagged "./app/.env.prod"
expect_flagged "app/deploy/railway/core.env"
expect_flagged "app/scripts/fixtures/docker-core-smoke-private-key.pem"
expect_flagged "console/server.key"
expect_flagged "root/.ssh/id_ed25519"
expect_flagged "app/credentials.json"
# .env files are flagged even under /usr: nothing legitimate ships one there.
expect_flagged "usr/local/app/.env"

expect_allowed "app/.env.docker.example"
expect_allowed "app/deploy/railway/core.env.example"
expect_allowed "app/node_modules/some-pkg/.env"
expect_allowed "app/node_modules/some-pkg/test/fixtures/key.pem"
expect_allowed "etc/ssl/certs/ca-certificates.pem"
expect_allowed "usr/share/ca-certificates/mozilla/ISRG_Root_X1.pem"
expect_allowed "app/.wh..env.docker"
expect_allowed "app/package.json"
expect_allowed "app/reference-implementation/server/auth/keys.ts"

# --- image mode, with a stubbed `docker save` ---------------------------------

STUB_BIN="$WORK_DIR/bin"
mkdir -p "$STUB_BIN"

# build_save_archive <out.tar> <file-in-layer>...
#   Writes a minimal `docker save` layout: manifest.json plus one layer tar.
build_save_archive() {
  local out="$1" root="$WORK_DIR/archive" f
  shift
  rm -rf "$root"
  mkdir -p "$root/layer-src" "$root/save/blobs/sha256"
  for f in "$@"; do
    mkdir -p "$root/layer-src/$(dirname "$f")"
    printf 'PDPP_DUMMY=not-a-secret\n' > "$root/layer-src/$f"
  done
  tar -cf "$root/save/blobs/sha256/layer0" -C "$root/layer-src" .
  printf '[{"Layers":["blobs/sha256/layer0"]}]\n' > "$root/save/manifest.json"
  tar -cf "$out" -C "$root/save" .
}

write_docker_stub() {
  cat > "$STUB_BIN/docker" <<'STUB'
#!/usr/bin/env bash
[[ "$1" == "save" ]] || exit 99
case "$2" in
  dirty:*) cat "$STUB_DIR/dirty.tar" ;;
  clean:*) cat "$STUB_DIR/clean.tar" ;;
  *) echo "Error response from daemon: reference does not exist" >&2; exit 1 ;;
esac
STUB
  chmod +x "$STUB_BIN/docker"
}

build_save_archive "$WORK_DIR/dirty.tar" app/package.json app/.env.docker
build_save_archive "$WORK_DIR/clean.tar" app/package.json app/.env.docker.example
write_docker_stub

run_image() {
  PATH="$STUB_BIN:$PATH" STUB_DIR="$WORK_DIR" TMPDIR="$WORK_DIR" \
    bash "$TARGET_SCRIPT" image "$1"
}

if out="$(run_image dirty:test 2>&1)"; then
  fail "image with .env.docker passed"
elif [[ "$out" == *"app/.env.docker"* && "$out" != *"not-a-secret"* ]]; then
  pass "image with .env.docker fails and names the file, not its contents"
else
  fail "unexpected output for dirty image: $out"
fi

if run_image clean:test >/dev/null 2>&1; then
  pass "image with only .env.docker.example passes"
else
  fail "clean image failed"
fi

if run_image missing:test >/dev/null 2>&1; then
  fail "an image that cannot be saved passed (must fail closed)"
else
  pass "an image that cannot be saved fails closed"
fi

# --- oci-archive mode, with a hand-built OCI layout -----------------------------

# build_oci_archive <out.tar> <file-in-layer>...
#   Writes index.json -> image index -> one platform manifest with the layer,
#   plus an attestation manifest whose in-toto layer must be skipped.
build_oci_archive() {
  local out="$1" root="$WORK_DIR/oci" f layer_sha att_sha manifest_sha index_sha att_manifest_sha
  shift
  rm -rf "$root"
  mkdir -p "$root/layer-src" "$root/layout/blobs/sha256"
  for f in "$@"; do
    mkdir -p "$root/layer-src/$(dirname "$f")"
    printf 'PDPP_DUMMY=not-a-secret\n' > "$root/layer-src/$f"
  done
  put() { local sha; sha="$(sha256sum "$1" | cut -d' ' -f1)"; mv "$1" "$root/layout/blobs/sha256/$sha"; echo "$sha"; }
  tar -czf "$root/l" -C "$root/layer-src" . && layer_sha="$(put "$root/l")"
  printf '{"predicateType":"x"}' > "$root/a" && att_sha="$(put "$root/a")"
  printf '{"mediaType":"application/vnd.oci.image.manifest.v1+json","layers":[{"mediaType":"application/vnd.oci.image.layer.v1.tar+gzip","digest":"sha256:%s"}]}' "$layer_sha" > "$root/m"
  manifest_sha="$(put "$root/m")"
  printf '{"mediaType":"application/vnd.oci.image.manifest.v1+json","layers":[{"mediaType":"application/vnd.in-toto+json","digest":"sha256:%s"}]}' "$att_sha" > "$root/am"
  att_manifest_sha="$(put "$root/am")"
  printf '{"mediaType":"application/vnd.oci.image.index.v1+json","manifests":[{"digest":"sha256:%s","platform":{"os":"linux","architecture":"amd64"}},{"digest":"sha256:%s","platform":{"os":"unknown","architecture":"unknown"}}]}' "$manifest_sha" "$att_manifest_sha" > "$root/i"
  index_sha="$(put "$root/i")"
  printf '{"schemaVersion":2,"manifests":[{"mediaType":"application/vnd.oci.image.index.v1+json","digest":"sha256:%s"}]}' "$index_sha" > "$root/layout/index.json"
  tar -cf "$out" -C "$root/layout" index.json blobs
  echo "sha256:$index_sha"
}

dirty_digest="$(build_oci_archive "$WORK_DIR/dirty.oci.tar" app/package.json app/.env.docker)"
clean_digest="$(build_oci_archive "$WORK_DIR/clean.oci.tar" app/package.json app/.env.docker.example)"

if out="$(bash "$TARGET_SCRIPT" oci-archive "$WORK_DIR/dirty.oci.tar" 2>&1)"; then
  fail "OCI archive with .env.docker passed"
elif [[ "$out" == *"app/.env.docker"* && "$out" == *"SCANNED-DIGEST: $dirty_digest"* ]]; then
  pass "OCI archive with .env.docker fails through index -> manifest -> layer"
else
  fail "unexpected output for dirty OCI archive: $out"
fi

if out="$(bash "$TARGET_SCRIPT" oci-archive "$WORK_DIR/clean.oci.tar" 2>&1)" &&
  [[ "$out" == *"SCANNED-DIGEST: $clean_digest"* ]]; then
  pass "clean OCI archive passes, skips the attestation layer, and reports its index digest"
else
  fail "clean OCI archive: $out"
fi

# A manifest whose bytes do not match its digest must fail, not be trusted.
tamper="$WORK_DIR/oci/layout"
printf '{"schemaVersion":2,"manifests":[{"digest":"sha256:%064d"}]}' 0 > "$tamper/index.json"
tar -cf "$WORK_DIR/tampered.oci.tar" -C "$tamper" index.json blobs
if bash "$TARGET_SCRIPT" oci-archive "$WORK_DIR/tampered.oci.tar" >/dev/null 2>&1; then
  fail "OCI archive with a missing manifest passed (must fail closed)"
else
  pass "OCI archive with a missing manifest fails closed"
fi

if [[ "$FAILURES" -gt 0 ]]; then
  echo "$FAILURES test(s) failed" >&2
  exit 1
fi
echo "all check-image-secrets tests passed"
