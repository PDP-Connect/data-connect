#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Benign Linux fixtures; no WebKit, sockets, or real account state.
set -euo pipefail
probe=$(dirname "$0")/webkitgtk-cookie-probe.sh
scratch=$(mktemp -d)
foreign=''
runner=''
cleanup() {
  [[ -z "$runner" ]] || kill -TERM "$runner" 2>/dev/null || true
  [[ -z "$foreign" ]] || kill -TERM "$foreign" 2>/dev/null || true
  [[ -z "$foreign" ]] || wait "$foreign" 2>/dev/null || true
  rm -rf -- "$scratch"
}
trap cleanup EXIT
export TMPDIR=$scratch PROBE_TEST_PRIVATE=synthetic-env-canary
sleep 30 &
foreign=$!
write_fixture() {
  printf '%s\n' '#!/usr/bin/env bash' "$2" >"$scratch/$1"
  chmod 700 "$scratch/$1"
}
write_fixture normal '
  [[ ! -v PROBE_TEST_PRIVATE ]] || exit 94
  echo "Cookie: synthetic-cookie-canary"
  echo "/fake/private/synthetic-path-canary" >&2
  sleep 30 &
  echo "$!" > "$TMPDIR/descendant"
  echo "WEBKITGTK COOKIE TEST RAN"
  echo "test result: ok. 1 passed; 0 failed;"
'
write_fixture nonzero '
  echo "Cookie: synthetic-cookie-canary"
  echo "WEBKITGTK COOKIE TEST RAN"
  echo "test result: ok. 1 passed; 0 failed;"
  exit 42
'
write_fixture missing 'echo "test result: ok. 1 passed; 0 failed;"'
write_fixture no_pass 'echo "WEBKITGTK COOKIE TEST RAN"'
write_fixture stall '
  echo "Cookie: synthetic-cookie-canary"
  sleep 30 &
  echo "$!" > "$TMPDIR/descendant"
  echo "WEBKITGTK COOKIE TEST RAN"
  wait
'
assert_output() {
  if grep -Eq 'synthetic-(cookie|path|env)-canary' "$scratch/summary"; then
    echo 'fixture: unsafe output escaped'; exit 1
  fi
  if compgen -G "$scratch/tmp.*" >/dev/null; then
    echo 'fixture: private scratch retained'; exit 1
  fi
  kill -0 "$foreign"
}
run_case() {
  local code=0
  bash "$probe" "$scratch/$1" >"$scratch/summary" 2>&1 || code=$?
  [[ "$code" == "$2" ]] || { echo "fixture: unexpected exit for $1 ($code)"; exit 1; }
  assert_output
  [[ "$code" == 0 ]] || assert_no_success
}
assert_no_success() {
  if grep -qxF 'probe: cookie test RAN and passed' "$scratch/summary"; then
    echo 'fixture: success reported for a failed run'; exit 1
  fi
}
assert_descendant_absent() {
  local child
  read -r child <"$scratch/descendant"
  if kill -0 "$child" 2>/dev/null; then
    echo 'fixture: owned descendant survived'; exit 1
  fi
  rm -f -- "$scratch/descendant"
}
run_case normal 0
if [[ "$(grep -cxF 'probe: cookie test RAN and passed' "$scratch/summary")" != 1 ]]; then
  echo 'fixture: success not reported exactly once'; exit 1
fi
assert_descendant_absent
run_case nonzero 42
run_case missing 1
run_case no_pass 1
# Exercise bounded timeout cancellation without waiting the full pre-RAN window.
bash "$probe" "$scratch/stall" >"$scratch/summary" 2>&1 &
runner=$!
for ((i=0; i<100; i++)); do
  [[ -s "$scratch/descendant" ]] && break
  sleep 0.05
done
[[ -s "$scratch/descendant" ]]
kill -TERM "$runner"
code=0
wait "$runner" || code=$?
runner=''
[[ "$code" == 124 ]] || { echo "fixture: unexpected timeout cancellation exit ($code)"; exit 1; }
assert_output
assert_no_success
assert_descendant_absent
echo 'fixture: probe summary and ownership checks passed'
