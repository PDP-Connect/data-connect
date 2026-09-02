#!/usr/bin/env bash
# Copyright The PDP-Connect Contributors
# SPDX-License-Identifier: Apache-2.0

set -u

status=0
for path in "$@"; do
  uv run python "$path" -v || status=$?
done
exit "$status"
