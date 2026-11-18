#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0

# Run the already-compiled WebKitGTK cookie test binary directly, with its
# output in a file (no pipe for a child to hold open), and report what keeps the
# process alive if it does not exit after the test prints its RAN marker.
# Usage (inside xvfb-run + dbus-run-session): webkitgtk-cookie-probe.sh <test-binary> <log>
# With PROBE_VIA=cargo it runs the test through `cargo test ... | tee <log>`
# instead, the path on which the stall was seen, and inspects the same tree.
# Records only process state, syscall numbers and symbol-only stacks: no
# environment, memory contents or network traffic.
set -uo pipefail
bin=$1
log=$2
: >"$log"
name=unified::tests::the_console_webview_sends_the_session_and_reveal_cookies
if [ "${PROBE_VIA:-binary}" = cargo ]; then
  (cargo test --lib -- --ignored --exact "$name" --nocapture 2>&1 | tee "$log" >/dev/null) &
else
  "$bin" --ignored --exact "$name" --nocapture >"$log" 2>&1 &
fi
pid=$!
echo "probe: root pid=$pid via ${PROBE_VIA:-binary}"

tree() { # print pid and all descendants of $1
  local p=$1 c
  echo "$p"
  for c in $(pgrep -P "$p" 2>/dev/null || true); do tree "$c"; done
}

# Wait for RAN (60 s), then for exit (10 s).
for _ in $(seq 1 600); do
  grep -q '^WEBKITGTK COOKIE TEST RAN$' "$log" && break
  kill -0 "$pid" 2>/dev/null || break
  sleep 0.1
done
for _ in $(seq 1 100); do
  kill -0 "$pid" 2>/dev/null || break
  sleep 0.1
done

if kill -0 "$pid" 2>/dev/null; then
  echo "probe: pid $pid STILL ALIVE after RAN (+10 s)"
  echo "--- process tree (pid ppid stat wchan comm)"
  for p in $(tree "$pid"); do
    ps -o pid=,ppid=,stat=,wchan:24=,comm= -p "$p" 2>/dev/null
  done
  for p in $(tree "$pid"); do
    echo "--- threads of $p $(cat /proc/"$p"/comm 2>/dev/null) (tid state wchan syscall-number comm)"
    for t in /proc/"$p"/task/*; do
      tid=${t##*/}
      printf '%s %s %s %s %s\n' "$tid" \
        "$(awk '/^State:/{print $2}' "$t/status" 2>/dev/null)" \
        "$(cat "$t/wchan" 2>/dev/null)" \
        "$(cut -d' ' -f1 "$t/syscall" 2>/dev/null)" \
        "$(cat "$t/comm" 2>/dev/null)"
    done
  done
  echo "--- stdout/stderr targets of the tree (fd 1, 2)"
  for p in $(tree "$pid"); do
    printf '%s: %s %s\n' "$p" "$(readlink /proc/"$p"/fd/1 2>/dev/null)" "$(readlink /proc/"$p"/fd/2 2>/dev/null)"
  done
  for p in $(tree "$pid"); do
    case "$(cat /proc/"$p"/comm 2>/dev/null)" in bash|sh|tee|"") continue ;; esac
    echo "--- gdb: all thread backtraces of $p $(cat /proc/"$p"/comm 2>/dev/null) (no frame arguments)"
    sudo -n timeout 40 gdb -p "$p" -batch -ex 'set pagination off' \
      -ex 'set print frame-arguments none' -ex 'thread apply all bt 30' 2>&1 | tail -n 300 \
      || echo "probe: gdb failed"
  done
  echo "--- end probe"
  for p in $(tree "$pid"); do kill -KILL "$p" 2>/dev/null || true; done
  wait "$pid" 2>/dev/null
  cat "$log"
  exit 124
fi

wait "$pid"
code=$?
echo "probe: root process exited with $code"
echo "--- remaining children of the probe shell (pid ppid stat comm)"
for p in $(pgrep -P $$ 2>/dev/null || true); do ps -o pid=,ppid=,stat=,comm= -p "$p" 2>/dev/null; done
cat "$log"
exit "$code"
