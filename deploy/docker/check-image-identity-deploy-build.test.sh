#!/usr/bin/env bash
# Copyright The PDP-Connect Contributors
# SPDX-License-Identifier: Apache-2.0
#
# Discriminating real-build test for deploy/docker/Dockerfile identity contract.
# Proves that the core stage of deploy/docker/Dockerfile now carries the same
# image identity contract as the root Dockerfile: OCI labels, validation check,
# and runtime env all enforce a single immutable revision value.
#
# This test actually builds from deploy/docker/Dockerfile (not a stub) and verifies:
# 1. A manual exact-SHA build carries the correct OCI label and runtime env
# 2. An ordinary dev build (no PDPP_REFERENCE_REVISION) carries honest 'unknown'
#
# The pre-fix deploy/docker/Dockerfile (before this commit) would produce images
# that fail step 1 (missing OCI labels) even when PDPP_REFERENCE_REVISION was set.
#
# Run: bash deploy/docker/check-image-identity-deploy-build.test.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CHECK_SCRIPT="$SCRIPT_DIR/check-image-identity.sh"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

echo "Discriminating real-build test: deploy/docker/Dockerfile identity contract"
echo "Repository root: $REPO_ROOT"
echo

if ! command -v docker >/dev/null 2>&1; then
  echo "SKIP: docker not found" >&2
  exit 0
fi

COMMIT_SHA=$(cd "$REPO_ROOT" && git rev-parse HEAD)
BUILD_ARGS=(
  --target core
  --build-arg "PDPP_REFERENCE_REVISION=$COMMIT_SHA"
  --build-arg "PDPP_BUILD_SOURCE=https://github.com/PDP-Connect/data-connect"
  --build-arg "PDPP_BUILD_CREATED=2026-09-25T00:00:00Z"
  --build-arg "PDPP_BUILD_DIRTY=0"
  --build-arg "PDPP_BUILD_COMPOSITION=core"
  --file deploy/docker/Dockerfile
  .
)

echo "Test 1: Exact-SHA build from deploy/docker/Dockerfile"
echo "  Building with PDPP_REFERENCE_REVISION=$COMMIT_SHA"
if IMAGE_ID=$(cd "$REPO_ROOT" && docker build "${BUILD_ARGS[@]}" -q 2>&1); then
  echo "  ✓ Build succeeded: $IMAGE_ID"
else
  echo "  ✗ Build failed" >&2
  exit 1
fi

echo "  Checking OCI label..."
LABEL=$(docker image inspect "$IMAGE_ID" --format '{{index .Config.Labels "org.opencontainers.image.revision"}}')
if [[ "$LABEL" == "$COMMIT_SHA" ]]; then
  echo "  ✓ OCI label correct: $LABEL"
else
  echo "  ✗ OCI label missing or wrong: $LABEL (expected $COMMIT_SHA)" >&2
  exit 1
fi

echo "  Checking runtime env..."
ENV=$(docker image inspect "$IMAGE_ID" --format '{{range .Config.Env}}{{println .}}{{end}}' | grep "^PDPP_REFERENCE_REVISION=" || echo "")
if [[ "$ENV" == "PDPP_REFERENCE_REVISION=$COMMIT_SHA" ]]; then
  echo "  ✓ Runtime env correct: $ENV"
else
  echo "  ✗ Runtime env missing or wrong: $ENV (expected PDPP_REFERENCE_REVISION=$COMMIT_SHA)" >&2
  exit 1
fi

echo "  Verifying with check-image-identity.sh --require-known..."
if bash "$CHECK_SCRIPT" --require-known "$IMAGE_ID" >/dev/null 2>&1; then
  echo "  ✓ Identity check passed"
else
  echo "  ✗ Identity check failed" >&2
  exit 1
fi

echo
echo "Test 2: Dev build (no PDPP_REFERENCE_REVISION) from deploy/docker/Dockerfile"
echo "  Building with default PDPP_REFERENCE_REVISION..."
if IMAGE_ID=$(cd "$REPO_ROOT" && docker build --target core --file deploy/docker/Dockerfile . -q 2>&1); then
  echo "  ✓ Build succeeded: $IMAGE_ID"
else
  echo "  ✗ Build failed" >&2
  exit 1
fi

echo "  Checking OCI label..."
LABEL=$(docker image inspect "$IMAGE_ID" --format '{{index .Config.Labels "org.opencontainers.image.revision"}}')
if [[ "$LABEL" == "unknown" ]]; then
  echo "  ✓ OCI label correct: $LABEL"
else
  echo "  ✗ OCI label wrong: $LABEL (expected 'unknown')" >&2
  exit 1
fi

echo "  Checking runtime env..."
ENV=$(docker image inspect "$IMAGE_ID" --format '{{range .Config.Env}}{{println .}}{{end}}' | grep "^PDPP_REFERENCE_REVISION=" || echo "")
if [[ "$ENV" == "PDPP_REFERENCE_REVISION=unknown" ]]; then
  echo "  ✓ Runtime env correct: $ENV"
else
  echo "  ✗ Runtime env wrong: $ENV (expected PDPP_REFERENCE_REVISION=unknown)" >&2
  exit 1
fi

echo "  Verifying with check-image-identity.sh --allow-unknown..."
if bash "$CHECK_SCRIPT" --allow-unknown "$IMAGE_ID" >/dev/null 2>&1; then
  echo "  ✓ Identity check passed (dev build)"
else
  echo "  ✗ Identity check failed" >&2
  exit 1
fi

echo "  Verifying rejection under --require-known (should fail)..."
if bash "$CHECK_SCRIPT" --require-known "$IMAGE_ID" >/dev/null 2>&1; then
  echo "  ✗ Identity check should have failed under --require-known" >&2
  exit 1
else
  echo "  ✓ Identity check correctly rejected under --require-known"
fi

echo
echo "All real-build tests passed"
