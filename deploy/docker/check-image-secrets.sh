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
#                      Prints the digest of the archive's top-level manifest
#                      as `SCANNED-DIGEST: sha256:...` so a caller can prove
#                      it pushes exactly what was scanned.
#   paths              Classify layer paths read from stdin (for tests).
#
# Output names files only, never contents. Exit 1 on any finding.
#
# Run: bash deploy/docker/check-image-secrets.sh image pdpp:ci-core-test

set -euo pipefail

# The secret-file rule. Input is a path inside a layer ("app/.env.docker").
# Allowed: *.example templates, OCI whiteout markers, and third-party files
# under node_modules or the OS certificate/library trees (CA bundles are
# public .pem files).
is_secret_path() {
  local path="${1#./}" name
  name="${path##*/}"
  case "$name" in
    .wh.*|*.example) return 1 ;;
  esac
  case "/$path" in
    */node_modules/*) return 1 ;;
  esac
  case "$name" in
    .env|.env.*|*.env) return 0 ;;
  esac
  case "/$path" in
    /etc/ssl/*|/usr/*|/opt/patchright-browsers/*) return 1 ;;
  esac
  case "$name" in
    *.pem|*.key|*.p12|*.pfx|*.jks|*.keystore) return 0 ;;
    id_rsa|id_dsa|id_ecdsa|id_ed25519) return 0 ;;
    credentials.json|service-account*.json|.netrc) return 0 ;;
  esac
  return 1
}

classify_paths() {
  local label="$1" path found=0
  while IFS= read -r path; do
    [[ -z "$path" || "$path" == */ ]] && continue
    if is_secret_path "$path"; then
      echo "SECRET-FILE: $label $path"
      found=1
    fi
  done
  return "$found"
}

scan_image() {
  local ref="$1" work layer listing found=0
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
    if ! listing="$(tar -tf "$work/$layer")"; then
      echo "ERROR: $ref layer $layer is not a readable tar" >&2
      found=2
      continue
    fi
    classify_paths "$ref layer=$layer" <<<"$listing" || [[ "$found" -eq 2 ]] || found=1
  done <<<"$layers"
  rm -rf "$work"
  if [[ "$found" -eq 0 ]]; then
    echo "OK: $ref has no secret-looking files in any layer"
  fi
  return "$found"
}

# Layer media types hold tar streams. Attestation manifests (provenance,
# SBOM) carry in-toto JSON layers; those are not filesystem content.
oci_layer_tar_flags() {
  case "$1" in
    *tar+gzip) echo "-z" ;;
    *tar+zstd) echo "--zstd" ;;
    *tar) echo "" ;;
    application/vnd.in-toto+json) echo "skip" ;;
    *) echo "unknown" ;;
  esac
}

scan_oci_archive() {
  local archive="$1" found=0 top todo=() digest blob doc mt layer flags listing
  blob_of() { printf 'blobs/sha256/%s' "${1#sha256:}"; }
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
      return 2
    fi
    while IFS= read -r digest; do
      [[ -n "$digest" ]] && todo+=("$digest")
    done < <(jq -r '.manifests[]?.digest' <<<"$doc")
    while IFS=$'\t' read -r mt layer; do
      [[ -n "$layer" ]] || continue
      flags="$(oci_layer_tar_flags "$mt")"
      [[ "$flags" == "skip" ]] && continue
      if [[ "$flags" == "unknown" ]]; then
        echo "ERROR: $archive layer $layer has unknown media type $mt" >&2
        found=2
        continue
      fi
      # shellcheck disable=SC2086
      # Drain after tar -t, as in scan_image, so the writer never sees SIGPIPE.
      if ! listing="$(tar -xOf "$archive" "$(blob_of "$layer")" | { tar -t $flags && cat >/dev/null; })"; then
        echo "ERROR: $archive layer $layer is not a readable tar" >&2
        found=2
        continue
      fi
      classify_paths "$archive layer=$layer" <<<"$listing" || [[ "$found" -eq 2 ]] || found=1
    done < <(jq -r '.layers[]? | [.mediaType, .digest] | @tsv' <<<"$doc")
  done
  echo "SCANNED-DIGEST: $top"
  if [[ "$found" -eq 0 ]]; then
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
