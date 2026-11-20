#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Usage (inside xvfb-run + dbus-run-session): webkitgtk-cookie-probe.sh <test-binary>
# Raw libtest stdout/stderr are private scratch. Only fixed summaries leave this script.
set -uo pipefail
# Bash job diagnostics are not part of the published summary.
exec 2>/dev/null
umask 077
bin=$1
name=unified::tests::the_console_webview_sends_the_session_and_reveal_cookies
scratch=$(mktemp -d) || { echo 'probe: scratch setup failed'; exit 125; }
log=$scratch/raw
status=$scratch/status
pid=''
identity=''
group_identity() {
  local stat
  local -a fields
  IFS= read -r stat <"/proc/$pid/stat" || return 1
  read -r -a fields <<< "${stat##*) }"
  [[ "${fields[2]:-}" == "$pid" && -n "${fields[19]:-}" ]] || return 1
  printf '%s\n' "${fields[19]}"
}
owns_group() { [[ -n "$identity" && "$(group_identity 2>/dev/null)" == "$identity" ]]; }
retire_group() {
  # With monitor mode, the single async subshell is the leader of its own
  # process group. Check the group, not PPID: its leader may already have exited.
  [[ -n "$pid" ]] || return 0
  kill -0 -- "-$pid" 2>/dev/null || return 0
  owns_group || return 1
  kill -TERM -- "-$pid" 2>/dev/null || true
  # The supervisor intentionally remains alive; allow children a bounded grace.
  sleep 0.5
  owns_group || return 1
  kill -KILL -- "-$pid" 2>/dev/null || true
  for ((i=0; i<20; i++)); do
    kill -0 -- "-$pid" 2>/dev/null || return 0
    sleep 0.1
  done
  return 1
}
finish() {
  local code=$?
  trap - EXIT
  trap '' TERM INT HUP
  if ! retire_group; then
    echo 'probe: process group retirement unconfirmed'
    code=125
  fi
  rm -f -- "$log" "$status" 2>/dev/null && rmdir -- "$scratch" 2>/dev/null || {
    echo 'probe: scratch cleanup failed'
    code=125
  }
  ((code != 0)) || echo 'probe: cookie test RAN and passed'
  exit "$code"
}
trap finish EXIT
trap 'exit 124' TERM INT HUP

# Explicit runtime environment: executable lookup, isolated home/temp and XDG
# directories, X display and authority, D-Bus, and the test's compile-root hint.
# Do not forward the workflow lease, Cargo credentials, or an ambient env dump.
allow=()
for key in PATH HOME TMPDIR TMP TEMP DISPLAY XAUTHORITY DBUS_SESSION_BUS_ADDRESS XDG_CONFIG_HOME XDG_DATA_HOME XDG_CACHE_HOME XDG_RUNTIME_DIR CARGO_MANIFEST_DIR TAURI_CONFIG; do
  [[ -v "$key" ]] && allow+=("$key=${!key}")
done
echo 'probe: starting cookie test'
set -m
(
  set +m
  # Hold the original group leader through normal child exit and TERM. A
  # matching /proc birth witness is required before signaling any group.
  trap ':' TERM
  ( exec env -i "${allow[@]}" "$bin" --ignored --exact "$name" --nocapture )
  printf '%d\n' "$?" >"$status"
  while :; do sleep 1; done
) >"$log" 2>&1 &
pid=$!
for ((i=0; i<10; i++)); do
  identity=$(group_identity) && break
  sleep 0.02
done
if [[ -z "$identity" ]]; then
  echo 'probe: process ownership could not be established'
  exit 125
fi

# A gate can only pass on this attempt's exit and exact RAN result. Before RAN
# allow 60s; once seen, allow up to 10s more for clean binary exit.
for ((i=0; i<600; i++)); do
  grep -qxF 'WEBKITGTK COOKIE TEST RAN' "$log" && break
  [[ -s "$status" ]] || owns_group || break
  [[ ! -s "$status" ]] || break
  sleep 0.1
done
for ((i=0; i<100; i++)); do
  [[ -s "$status" ]] || owns_group || break
  [[ ! -s "$status" ]] || break
  sleep 0.1
done
if [[ ! -s "$status" ]]; then
  echo 'probe: cookie test timed out'
  exit 124
fi
IFS= read -r code <"$status" || exit 125
if ((code != 0)); then
  printf 'probe: cookie test exited with status %d\n' "$code"
  exit "$code"
fi
if ! grep -qxF 'WEBKITGTK COOKIE TEST RAN' "$log"; then
  echo 'probe: cookie test RAN marker missing'
  exit 1
fi
if ! grep -q '^test result: ok\. 1 passed;' "$log"; then
  echo 'probe: cookie test pass result missing'
  exit 1
fi
echo 'probe: cookie test RAN and passed'
