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
# Case-insensitive, and the node_modules exemption applies to the cleaned path.
expect_flagged "app/.ENV.docker"
expect_flagged "app/Server.PEM"
expect_flagged "app//./.env.docker"
# The exemption is the node_modules directory, not any name containing it.
expect_flagged "app/node_modules_backup/.env.docker"
# Dev data and extra key types the ignore files now exclude.
expect_flagged "app/.envrc"
expect_flagged "app/packages/polyfill-connectors/.pdpp-data/pdpp.sqlite"
expect_flagged "app/.pdpp-data/config.json"
expect_flagged "app/dev.sqlite"
expect_flagged "app/dev.sqlite-wal"
expect_flagged "app/release.jks"
expect_flagged "root/.netrc"
expect_flagged "root/.ssh/id_ecdsa"
# Only the CA bundle tree of /etc/pki is exempt; its private-key tree is not.
expect_flagged "etc/pki/tls/private/localhost.key"

expect_allowed "app/.env.docker.example"
expect_allowed "app/deploy/railway/core.env.example"
expect_allowed "app/node_modules/some-pkg/.env"
expect_allowed "app/node_modules/some-pkg/test/fixtures/key.pem"
expect_allowed "etc/ssl/certs/ca-certificates.pem"
expect_allowed "etc/pki/ca-trust/extracted/pem/tls-ca-bundle.pem"
expect_allowed "usr/share/ca-certificates/mozilla/ISRG_Root_X1.pem"
expect_allowed "app/.wh..env.docker"
expect_allowed "app/package.json"
expect_allowed "app/reference-implementation/server/auth/keys.ts"

# A ".." segment is an error, not a node_modules exemption: applying the
# layer cleans app/node_modules/../.env.docker to app/.env.docker.
if out="$(printf 'app/node_modules/../.env.docker\n' | bash "$TARGET_SCRIPT" paths 2>&1)"; then
  fail "a .. segment under node_modules passed"
elif [[ "$out" == *".. segment"* ]]; then
  pass "a .. segment fails instead of taking the node_modules exemption"
else
  fail "unexpected output for a .. segment: $out"
fi

# --- image mode, with a stubbed `docker save` ---------------------------------

STUB_BIN="$WORK_DIR/bin"
mkdir -p "$STUB_BIN"

# build_save_archive <out.tar> <file-in-layer>...
#   Writes a minimal `docker save` layout: manifest.json plus one layer tar.
build_save_archive() {
  local out="$1" root="$WORK_DIR/archive" f sha
  shift
  rm -rf "$root"
  mkdir -p "$root/layer-src" "$root/save/blobs/sha256"
  for f in "$@"; do
    mkdir -p "$root/layer-src/$(dirname "$f")"
    printf 'PDPP_DUMMY=not-a-secret\n' > "$root/layer-src/$f"
  done
  tar -cf "$root/layer0" -C "$root/layer-src" .
  sha="$(sha256sum "$root/layer0" | cut -d' ' -f1)"
  mv "$root/layer0" "$root/save/blobs/sha256/$sha"
  printf '[{"Layers":["blobs/sha256/%s"]}]\n' "$sha" > "$root/save/manifest.json"
  tar -cf "$out" -C "$root/save" .
}

build_tampered_save_archive() {
  local out="$1" root="$WORK_DIR/tampered-save" sha
  rm -rf "$root"
  mkdir -p "$root/save/blobs/sha256"
  printf 'valid layer bytes' > "$root/layer"
  sha="$(sha256sum "$root/layer" | cut -d' ' -f1)"
  printf '[{"Layers":["blobs/sha256/%s"]}]\n' "$sha" > "$root/save/manifest.json"
  printf 'different layer bytes' > "$root/save/blobs/sha256/$sha"
  tar -cf "$out" -C "$root/save" .
}

write_docker_stub() {
  cat > "$STUB_BIN/docker" <<'STUB'
#!/usr/bin/env bash
[[ "$1" == "save" ]] || exit 99
case "$2" in
  dirty:*) cat "$STUB_DIR/dirty.tar" ;;
  clean:*) cat "$STUB_DIR/clean.tar" ;;
  tampered:*) cat "$STUB_DIR/tampered-image.tar" ;;
  *) echo "Error response from daemon: reference does not exist" >&2; exit 1 ;;
esac
STUB
  chmod +x "$STUB_BIN/docker"
}

build_save_archive "$WORK_DIR/dirty.tar" app/package.json app/.env.docker
build_save_archive "$WORK_DIR/clean.tar" app/package.json app/.env.docker.example
build_tampered_save_archive "$WORK_DIR/tampered-image.tar"
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

if out="$(run_image tampered:test 2>&1)"; then
  fail "image with a layer digest mismatch passed"
elif [[ "$out" == *"does not match its digest"* ]]; then
  pass "image mode rejects a layer digest mismatch"
else
  fail "unexpected output for tampered image: $out"
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
elif [[ "$out" == *"app/.env.docker"* && "$out" != *"SCANNED-DIGEST"* && "$dirty_digest" == sha256:* ]]; then
  pass "OCI archive with .env.docker fails through index -> manifest -> layer and prints no digest"
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

# --- crafted multi-platform archives (oci_fixture.py) ------------------------
#
# oci_fixture.py writes an OCI layout tarball: two platforms (amd64, arm64),
# two layers each, plus an attestation manifest. A case names a defect.

FIXTURE="$WORK_DIR/oci_fixture.py"
cat > "$FIXTURE" <<'PY'
import gzip, hashlib, io, json, sys, tarfile

case, out = sys.argv[1], sys.argv[2]
blobs = []  # (name, bytes), written in order; duplicates allowed

def put(data):
    digest = hashlib.sha256(data).hexdigest()
    if ("blobs/sha256/" + digest, data) not in blobs:
        blobs.append(("blobs/sha256/" + digest, data))
    return "sha256:" + digest

def layer(members):
    if case == "pax-global" and any(name == "app/.env.docker" for name, _, _ in members):
        raw = io.BytesIO()
        def append(info, data=b""):
            raw.write(info.tobuf(format=tarfile.USTAR_FORMAT))
            raw.write(data)
            raw.write(b"\0" * ((-len(data)) % 512))
        for name, kind, data in members:
            if name == "app/.env.docker":
                value = "path=app/zzz-readme.txt"
                size = 0
                while size != len(f"{size} {value}\n".encode()):
                    size = len(f"{size} {value}\n".encode())
                pax = f"{size} {value}\n".encode()
                header = tarfile.TarInfo("GlobalHead.0")
                header.type = tarfile.XGLTYPE
                header.size = len(pax)
                append(header, pax)
            info = tarfile.TarInfo(name)
            info.type = kind
            info.size = len(data)
            append(info, data)
        raw.write(b"\0" * 1024)
        return gzip.compress(raw.getvalue(), mtime=0)
    raw = io.BytesIO()
    with tarfile.open(fileobj=raw, mode="w", format=tarfile.PAX_FORMAT) as t:
        for name, kind, data in members:
            info = tarfile.TarInfo(name)
            info.type = kind
            info.size = len(data)
            t.addfile(info, io.BytesIO(data))
    return gzip.compress(raw.getvalue(), mtime=0)

REG, DIR = tarfile.REGTYPE, tarfile.DIRTYPE
dummy = b"PDPP_DUMMY=not-a-secret\n"
base = [("etc/", DIR, b""), ("etc/os-release", REG, b"ID=test\n")]
app = [("app/", DIR, b""), ("app/package.json", REG, b"{}\n")]
secret = {
    "pax-global": [("app/.env.docker", REG, dummy)],
    "arm64-layer2": [("app/.env.docker", REG, dummy)],
    "dotdot": [("app/node_modules/../.env.docker", REG, dummy)],
    "slash": [("app/.env.docker/", REG, dummy)],
    "whiteout": [("app/.wh.env.docker", REG, dummy)],
    "hardlink": [("app/.env.docker", tarfile.LNKTYPE, b"")],
    "contig7": [("app/.env.docker", tarfile.CONTTYPE, dummy)],
    "case": [("app/.ENV.docker", REG, dummy)],
    "dup-member": [("app/.env.docker", REG, b""), ("app/.env.docker", REG, dummy)],
}.get(case, [])

LAYER_MT = "application/vnd.oci.image.layer.v1.tar+gzip"
def manifest(layers, layer_mt=LAYER_MT):
    doc = {"schemaVersion": 2, "mediaType": "application/vnd.oci.image.manifest.v1+json",
           "layers": [{"mediaType": layer_mt, "digest": put(l)} for l in layers]}
    return json.dumps(doc).encode()

amd64 = manifest([layer(base), layer(app)])
arm64_layers = [layer(base), layer(app + secret)]
arm64 = manifest(arm64_layers, "application/x-unknown" if case == "unknown-type" else LAYER_MT)
if case == "dup-blob":
    # A clean decoy under the dirty layer's name, ahead of the dirty blob.
    dirty = layer(app + [("app/.env.docker", REG, dummy)])
    arm64 = manifest([layer(base), dirty])
    name = "blobs/sha256/" + hashlib.sha256(dirty).hexdigest()
    blobs.insert(0, (name, layer(app)))
if case == "layer-mismatch":
    name, data = blobs[-1]
    blobs[-1] = (name, layer(app + [("app/.env.docker", REG, dummy)]))
att = manifest([b'{"predicateType":"x"}'], "application/vnd.in-toto+json")
entries = []
for m, arch in ((amd64, "amd64"), (arm64, "arm64")):
    d = put(m)
    if case == "manifest-mismatch" and arch == "arm64":
        blobs[-1] = (blobs[-1][0], m.replace(b'"schemaVersion": 2', b'"schemaVersion":  2'))
    entries.append({"mediaType": "application/vnd.oci.image.manifest.v1+json",
                    "digest": d, "platform": {"os": "linux", "architecture": arch}})
entries.append({"mediaType": "application/vnd.oci.image.manifest.v1+json",
                "digest": put(att), "platform": {"os": "unknown", "architecture": "unknown"}})
index = put(json.dumps({"schemaVersion": 2,
                        "mediaType": "application/vnd.oci.image.index.v1+json",
                        "manifests": entries}).encode())
top = json.dumps({"schemaVersion": 2, "manifests": [
    {"mediaType": "application/vnd.oci.image.index.v1+json", "digest": index}]}).encode()
with tarfile.open(out, "w") as t:
    outer = [("index.json", top)] + blobs
    if case == "outer-dot-index":
        outer.append(("./index.json", top))
    for name, data in outer:
        info = tarfile.TarInfo(name)
        info.size = len(data)
        t.addfile(info, io.BytesIO(data))
print(index)
PY

# expect_oci <case> <pass|secret|error> <description> [output substring]
expect_oci() {
  local case="$1" want="$2" desc="$3" needle="${4:-}" digest out rc=0
  digest="$(python3 "$FIXTURE" "$case" "$WORK_DIR/$case.oci.tar")"
  out="$(bash "$TARGET_SCRIPT" oci-archive "$WORK_DIR/$case.oci.tar" 2>&1)" || rc=$?
  if case "$want" in
    pass) [[ "$rc" -eq 0 && "$out" == *"SCANNED-DIGEST: $digest"* ]] ;;
    secret) [[ "$rc" -ne 0 && "$out" == *"SECRET-FILE:"* && "$out" != *"SCANNED-DIGEST"* ]] ;;
    error) [[ "$rc" -ne 0 && "$out" == *"ERROR:"* && "$out" != *"SCANNED-DIGEST"* ]] ;;
  esac && [[ "$out" == *"$needle"* ]]; then
    pass "$desc"
  else
    fail "$desc (rc=$rc): $out"
  fi
}

expect_oci clean pass "clean two-platform, two-layer archive passes and reports its digest"
expect_oci arm64-layer2 secret "a secret only in layer 2 of the arm64 manifest fails" "app/.env.docker"
expect_oci unknown-type error "an unknown layer media type fails closed" "unknown media type"
expect_oci manifest-mismatch error "a manifest whose bytes do not match its digest fails" "does not match its digest"
expect_oci layer-mismatch error "a layer blob whose bytes do not match its digest fails" "does not match its digest"
expect_oci dup-blob error "a duplicate blob member (clean decoy first) fails" "duplicate normalized member"
expect_oci dup-member error "a duplicate member name inside a layer fails" "duplicate member app/.env.docker"
expect_oci dotdot error "a layer member with a .. segment fails" ".. segment"
expect_oci slash error "a regular file whose name ends in / fails" "name ending in /"
expect_oci whiteout error "a non-empty whiteout file fails" "is not empty"
expect_oci case secret "an upper-case .ENV.docker is flagged" "app/.ENV.docker"
expect_oci pax-global error "a PAX global path override fails closed" "pax global header"
expect_oci outer-dot-index error "index.json and ./index.json collide after normalization" "duplicate normalized member index.json"
expect_oci hardlink secret "a hardlink named like a secret is flagged" "app/.env.docker"
expect_oci contig7 secret "a contiguous file named like a secret is flagged" "app/.env.docker"


if [[ "$FAILURES" -gt 0 ]]; then
  echo "$FAILURES test(s) failed" >&2
  exit 1
fi
echo "all check-image-secrets tests passed"
