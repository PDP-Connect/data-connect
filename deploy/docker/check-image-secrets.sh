#!/usr/bin/env bash
# Copyright The PDP-Connect Contributors
# SPDX-License-Identifier: Apache-2.0
#
# Fails when an operator secret file is in a Docker image or would enter one.
#
# Operators create .env.docker (owner password, credential encryption key,
# connector passwords) next to docker-compose.yml, and every Dockerfile here
# does `COPY . .`. Only the ignore files keep such a file out of the image.
# This script checks that from two sides:
#
#   image <ref>...     `docker save` each image and list EVERY layer, not only
#                      the final filesystem. A file that a later layer
#                      deletes is still in the published image.
#   context <dir>...   Plant dummy secret files in a build context, build a
#                      scratch image with `COPY . /ctx`, and scan it. A CI
#                      checkout never has a .env.docker, so an image scan
#                      alone cannot see a missing ignore rule; this can.
#                      Also checks the same dummies against .railwayignore,
#                      because `railway up` uploads the repository root.
#   oci-archive <tar>  Scan an OCI image layout tarball (buildx
#                      `--output type=oci`) without unpacking it: every
#                      nested index, every platform manifest, every layer.
#                      Every blob must match its digest. Only a clean scan
#                      prints the digest of the archive's top-level manifest
#                      as `SCANNED-DIGEST: sha256:...`, so a caller can prove
#                      it pushes exactly what was scanned.
#   paths              Classify layer paths read from stdin (for tests).
#
# Layer members are listed with Python's tarfile, not `tar -t`: GNU tar
# lists a regular file named "x/" as a directory, but a runtime that cleans
# the path writes it as the regular file "x". A layer is an error if it has a
# duplicate member, a ".." segment, a regular file whose name ends in "/", or
# a non-empty whiteout, because the scanned name then differs from the file
# a runtime would write.
#
# Output names files only, never contents. Exit 1 on any finding.
#
# Run: bash deploy/docker/check-image-secrets.sh image pdpp:ci-core-test

set -euo pipefail

# The secret-file rule. Input is a normalized path inside a layer
# ("app/.env.docker"). Matching is case-insensitive: a runtime on a
# case-insensitive filesystem, or an app that lowercases names, reads
# ".ENV.docker" as ".env.docker".
# Allowed: *.example templates, whiteout markers (list_members rejects a
# non-empty one), and third-party files under node_modules or the OS
# certificate/library trees (CA bundles are public .pem files). Of /etc/pki
# only ca-trust is allowed: it holds the extracted CA bundles on Fedora and
# RHEL bases, while /etc/pki/tls/private holds private keys.
is_secret_path() {
  local path="${1,,}" name
  name="${path##*/}"
  case "$name" in
    .wh.*|*.example) return 1 ;;
  esac
  case "/$path" in
    */node_modules/*) return 1 ;;
  esac
  case "$name" in
    .env|.env.*|*.env|.envrc) return 0 ;;
  esac
  case "/$path" in
    */.pdpp-data/*) return 0 ;;
    /etc/ssl/*|/etc/pki/ca-trust/*|/usr/*|/opt/patchright-browsers/*) return 1 ;;
  esac
  case "$name" in
    *.pem|*.key|*.p12|*.pfx|*.jks|*.keystore) return 0 ;;
    id_rsa|id_dsa|id_ecdsa|id_ed25519) return 0 ;;
    credentials.json|service-account*.json|.netrc) return 0 ;;
    *.sqlite|*.sqlite-*|*.sqlite3|*.sqlite3-*) return 0 ;;
  esac
  return 1
}

# normalize_path <path>: drop "./" and empty segments. Prints nothing and
# fails on a ".." segment: the scanned name would not be the written name.
normalize_path() {
  local IFS=/ seg out=()
  local -a segs
  read -r -a segs <<<"$1"
  for seg in "${segs[@]}"; do
    case "$seg" in
      ""|.) ;;
      ..) return 1 ;;
      *) out+=("$seg") ;;
    esac
  done
  printf '%s' "${out[*]}"
}

# list_members: read one tar stream on stdin, print "<type>\t<size>\t<name>"
# per member. Fails on a stream that is not a tar or holds duplicate names.
list_members() {
  python3 -c '
import sys, tarfile
seen = set()
with tarfile.open(fileobj=sys.stdin.buffer, mode="r|") as t:
    for m in t:
        if "\n" in m.name or "\t" in m.name:
            sys.exit("member name holds a tab or newline")
        key = m.name.rstrip("/")
        if key in seen:
            sys.exit("duplicate member " + m.name)
        seen.add(key)
        kind = "0" if m.type == tarfile.AREGTYPE else m.type.decode()
        print(kind, m.size, m.name, sep="\t")
# Drain past the end-of-archive marker so the writer never sees SIGPIPE.
while sys.stdin.buffer.read(1 << 20):
    pass
'
}

# hash_through <file>: copy stdin to stdout and write the sha256 of the bytes
# to <file>, so a blob is hashed and listed in one read.
hash_through() {
  python3 -c '
import hashlib, sys
h = hashlib.sha256()
while chunk := sys.stdin.buffer.read(1 << 20):
    h.update(chunk)
    sys.stdout.buffer.write(chunk)
open(sys.argv[1], "w").write("sha256:" + h.hexdigest())
' "$1"
}

# file_codec <file>: gzip, zstd or empty (plain tar), from the magic bytes.
file_codec() {
  case "$(head -c 4 "$1" | od -An -tx1 | tr -d ' \n')" in
    1f8b*) echo gzip ;;
    28b52ffd) echo zstd ;;
    *) echo "" ;;
  esac
}

# classify_members <label>: read list_members output on stdin. Returns 1 on a
# secret-looking file, 2 on a member whose written name the scan cannot know.
classify_members() {
  local label="$1" type size path norm found=0
  while IFS=$'\t' read -r type size path; do
    [[ -n "$path" ]] || continue
    if ! norm="$(normalize_path "$path")"; then
      echo "ERROR: $label member $path has a .. segment" >&2
      found=2
      continue
    fi
    # Directories carry no bytes. "5" is a directory; a regular file ("0")
    # whose name ends in "/" is written as the file without the slash.
    [[ "$type" == 5 ]] && continue
    if [[ "$path" == */ && "$type" == 0 ]]; then
      echo "ERROR: $label regular file $path has a name ending in /" >&2
      found=2
      continue
    fi
    if [[ "${norm##*/}" == .wh.* && "$size" != 0 ]]; then
      echo "ERROR: $label whiteout $path is not empty" >&2
      found=2
      continue
    fi
    if is_secret_path "$norm"; then
      echo "SECRET-FILE: $label $path"
      [[ "$found" -eq 2 ]] || found=1
    fi
  done
  return "$found"
}

# classify_paths <label>: bare paths on stdin, as regular files (tests).
classify_paths() {
  local path
  while IFS= read -r path; do
    if [[ -n "$path" ]]; then printf '0\t0\t%s\n' "$path"; fi
  done | classify_members "$1"
}

# scan_layer <label> <codec>: a layer tar stream on stdin; codec is gzip,
# zstd or empty.
scan_layer() {
  local label="$1" codec="$2" listing rc=0
  if ! listing="$(case "$codec" in
      gzip) gzip -dc ;;
      zstd) zstd -dc ;;
      *) cat ;;
    esac | list_members)"; then
    echo "ERROR: $label is not a readable tar" >&2
    return 2
  fi
  classify_members "$label" <<<"$listing" || rc=$?
  return "$rc"
}

scan_image() {
  local ref="$1" work layer codec found=0 rc
  # Fail closed: callers use `scan_image ... || rc=1`, which disables set -e
  # inside this function, so every step checks its own status.
  work="$(mktemp -d "${TMPDIR:-/tmp}/pdpp-image-scan.XXXXXX")" || return 2
  # tar stops at the end-of-archive marker; drain the rest so `docker save`
  # does not die of SIGPIPE and fail the pipeline under pipefail.
  if ! docker save "$ref" | { tar -x -C "$work" && cat >/dev/null; }; then
    echo "ERROR: could not save and unpack $ref" >&2
    rm -rf "$work"
    return 2
  fi
  # manifest.json names every layer, in both the OCI (blobs/sha256/*) and
  # the older */layer.tar layouts. An unreadable layer is an error, not a skip.
  local layers
  if ! layers="$(jq -er '.[].Layers[]' "$work/manifest.json")"; then
    echo "ERROR: $ref has no readable layer list" >&2
    rm -rf "$work"
    return 2
  fi
  while IFS= read -r layer; do
    if [[ "$layer" == blobs/sha256/* ]] &&
      [[ "$(sha256sum <"$work/$layer" | cut -d' ' -f1)" != "${layer#blobs/sha256/}" ]]; then
      echo "ERROR: $ref layer $layer does not match its digest" >&2
      found=2
      continue
    fi
    codec="$(file_codec "$work/$layer")"
    scan_layer "$ref layer=$layer" "$codec" <"$work/$layer" || {
      rc=$?
      [[ "$found" -eq 2 ]] || found="$rc"
    }
  done <<<"$layers"
  rm -rf "$work"
  if [[ "$found" -eq 0 ]]; then
    echo "OK: $ref has no secret-looking files in any layer"
  fi
  return "$found"
}

# Layer media types hold tar streams. Attestation manifests (provenance,
# SBOM) carry in-toto JSON layers; those are not filesystem content.
oci_layer_codec() {
  case "$1" in
    *tar+gzip) echo "gzip" ;;
    *tar+zstd) echo "zstd" ;;
    *tar) echo "" ;;
    application/vnd.in-toto+json) echo "skip" ;;
    *) echo "unknown" ;;
  esac
}

scan_oci_archive() {
  local archive="$1" found=0 top todo=() digest blob doc mt layer codec rc dups hashfile
  blob_of() { printf 'blobs/sha256/%s' "${1#sha256:}"; }
  # tar -xO concatenates duplicate members, and an unpacker keeps the last
  # one, so a duplicate could show the scan different bytes from the push.
  if ! dups="$(tar -tf "$archive" | sort | uniq -d)"; then
    echo "ERROR: $archive is not a readable tar" >&2
    return 2
  fi
  if [[ -n "$dups" ]]; then
    echo "ERROR: $archive has duplicate members: $dups" >&2
    return 2
  fi
  hashfile="$(mktemp "${TMPDIR:-/tmp}/pdpp-blob-hash.XXXXXX")" || return 2
  if ! top="$(tar -xOf "$archive" index.json | jq -er '.manifests[].digest')"; then
    echo "ERROR: $archive has no readable index.json" >&2
    return 2
  fi
  if [[ "$(wc -l <<<"$top")" -ne 1 ]]; then
    echo "ERROR: $archive must hold exactly one top-level image, found: $top" >&2
    return 2
  fi
  todo=("$top")
  while [[ "${#todo[@]}" -gt 0 ]]; do
    digest="${todo[0]}"
    todo=("${todo[@]:1}")
    blob="$(blob_of "$digest")"
    # Hash the blob bytes, not "$doc": $(...) strips trailing newlines.
    if ! doc="$(tar -xOf "$archive" "$blob")" ||
      [[ "sha256:$(tar -xOf "$archive" "$blob" | sha256sum | cut -d' ' -f1)" != "$digest" ]]; then
      echo "ERROR: $archive manifest $digest is missing or does not match its digest" >&2
      rm -f "$hashfile"
      return 2
    fi
    while IFS= read -r digest; do
      [[ -n "$digest" ]] && todo+=("$digest")
    done < <(jq -r '.manifests[]?.digest' <<<"$doc")
    while IFS=$'\t' read -r mt layer; do
      [[ -n "$layer" ]] || continue
      codec="$(oci_layer_codec "$mt")"
      [[ "$codec" == "skip" ]] && continue
      if [[ "$codec" == "unknown" ]]; then
        echo "ERROR: $archive layer $layer has unknown media type $mt" >&2
        found=2
        continue
      fi
      : >"$hashfile"
      rc=0
      tar -xOf "$archive" "$(blob_of "$layer")" | hash_through "$hashfile" |
        scan_layer "$archive layer=$layer" "$codec" || rc=$?
      if [[ "$(cat "$hashfile")" != "$layer" ]]; then
        echo "ERROR: $archive layer $layer is missing or does not match its digest" >&2
        rc=2
      fi
      [[ "$rc" -eq 0 || "$found" -eq 2 ]] || found="$rc"
    done < <(jq -r '.layers[]? | [.mediaType, .digest] | @tsv' <<<"$doc")
  done
  rm -f "$hashfile"
  # The digest is the caller's licence to push, so print it only when clean.
  if [[ "$found" -eq 0 ]]; then
    echo "SCANNED-DIGEST: $top"
    echo "OK: $archive has no secret-looking files in any layer of any platform"
  fi
  return "$found"
}

# Dummy files an operator is told to create, or that commonly hold secrets.
# Values are fixed dummies; the scan reports names only.
DUMMY_FILES=(
  .env
  .env.docker
  .env.local
  .env.prod
  deploy/railway/core.env
  server.pem
  server.key
  credentials.json
  .envrc
  .netrc
  release.jks
  dev.sqlite
)

scan_context() {
  local dir="$1" tag planted=() f found=0 probe
  tag="pdpp-secret-context-probe:$$"
  # Remove planted dummies and the probe image even if the build fails.
  trap 'for f in "${planted[@]}"; do rm -f "$dir/$f"; done; docker image rm -f "$tag" >/dev/null 2>&1 || true' EXIT
  for f in "${DUMMY_FILES[@]}"; do
    [[ -d "$dir/$(dirname "$f")" ]] || continue
    if [[ ! -e "$dir/$f" ]]; then
      printf 'PDPP_DUMMY=not-a-secret\n' > "$dir/$f"
      planted+=("$f")
    fi
  done
  printf 'FROM scratch\nCOPY . /ctx\n' |
    docker build -q -t "$tag" -f - "$dir" >/dev/null
  scan_image "$tag" || found=1
  for f in "${planted[@]}"; do rm -f "$dir/$f"; done
  planted=()
  docker image rm -f "$tag" >/dev/null
  trap - EXIT

  if [[ -f "$dir/.railwayignore" ]]; then
    # railway up follows gitignore syntax. Test .railwayignore alone, in a
    # scratch repo, so .gitignore cannot hide a missing rule.
    probe="$(mktemp -d)"
    git -C "$probe" init -q
    cp "$dir/.railwayignore" "$probe/.gitignore"
    for f in "${DUMMY_FILES[@]}"; do
      if ! git -C "$probe" check-ignore -q --no-index "$f"; then
        echo "SECRET-FILE: railway-upload $dir/.railwayignore does not ignore $f"
        found=1
      fi
    done
    rm -rf "$probe"
  fi
  return "$found"
}

main() {
  local mode="${1:-}" rc=0 arg
  shift || true
  case "$mode" in
    image)
      [[ $# -gt 0 ]] || { echo "usage: $0 image <ref>..." >&2; exit 2; }
      for arg in "$@"; do scan_image "$arg" || rc=1; done
      ;;
    context)
      [[ $# -gt 0 ]] || { echo "usage: $0 context <dir>..." >&2; exit 2; }
      for arg in "$@"; do scan_context "$arg" || rc=1; done
      ;;
    oci-archive)
      [[ $# -gt 0 ]] || { echo "usage: $0 oci-archive <tar>..." >&2; exit 2; }
      for arg in "$@"; do scan_oci_archive "$arg" || rc=1; done
      ;;
    paths)
      classify_paths "${1:-stdin}" || rc=1
      ;;
    *)
      echo "usage: $0 {image <ref>...|context <dir>...|oci-archive <tar>...|paths [label]}" >&2
      exit 2
      ;;
  esac
  return "$rc"
}

main "$@"
