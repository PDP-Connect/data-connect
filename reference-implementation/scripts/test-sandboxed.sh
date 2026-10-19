#!/usr/bin/env bash
# Copyright The PDP-Connect Contributors
# SPDX-License-Identifier: Apache-2.0
#
# Run a test command in the vendored test-sandbox (scripts/test-sandbox/README.md).
# scripts/test-scratch/run-command.ts runs outside it and owns the scratch
# directory; passing that directory as --scratch keeps TMPDIR unchanged inside
# the sandbox, so nested scratch-ownership checks and cleanup still match.
set -euo pipefail
exec "$(dirname "$0")/../../scripts/test-sandbox/test-sandbox" --scratch "${TMPDIR:?run this through scripts/test-scratch/run-command.ts}" "$@"
