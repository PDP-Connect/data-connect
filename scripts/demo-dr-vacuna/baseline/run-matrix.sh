#!/bin/sh
# Copyright The PDP-Connect Contributors
# SPDX-License-Identifier: Apache-2.0
#
# The configuration matrix reported in RESULTS.md. Each line is
#   <label> <pool_max|default> <synchronous_commit>
# Extra arguments are passed to loadgen.ts for every run.
set -eu
HERE=$(cd "$(dirname "$0")" && pwd)
STAGES="--stages 4,8,16,32,64,128,256 --stage-seconds 30 --warmup-seconds 5"
while read -r label pool sync; do
  [ -z "$label" ] && continue
  echo "=== $label (pool=$pool synchronous_commit=$sync)"
  # shellcheck disable=SC2086
  "$HERE/experiment.sh" "$label" "$pool" "$sync" $STAGES "$@" </dev/null
done <<MATRIX
${VACUNA_MATRIX:-pool8-sync-on-a default on
pool8-sync-on-b default on
pool32-sync-on 32 on
pool8-sync-off default off
pool32-sync-off 32 off}
MATRIX
