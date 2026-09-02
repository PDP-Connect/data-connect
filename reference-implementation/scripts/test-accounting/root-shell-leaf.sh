#!/usr/bin/env bash
# Copyright The PDP-Connect Contributors
# SPDX-License-Identifier: Apache-2.0

set -u

status=0
for path in "$@"; do
  bash "$path" || status=$?
done
exit "$status"
