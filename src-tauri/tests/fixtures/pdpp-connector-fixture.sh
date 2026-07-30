#!/bin/sh
read -r start
printf '%s' "$start" | grep -q '"type":"START"' || exit 71
record='{"type":"RECORD","stream":"items","key":"item-1","data":{"id":"item-1","source_updated_at":"2026-07-30T00:00:00Z"},"emitted_at":"2026-07-30T00:00:00Z"}'
done='{"type":"DONE","status":"succeeded","records_emitted":1}'
case "$1" in
success) echo 'fixture diagnostic' >&2; echo "$record"; echo '{"type":"STATE","stream":"items","cursor":{"cursor":"next"}}'; echo "$done" ;;
malformed) echo '{not json' ;;
duplicate-done) echo '{"type":"DONE","status":"succeeded","records_emitted":0}'; echo '{"type":"DONE","status":"succeeded","records_emitted":0}' ;;
missing-done) echo "$record" ;;
counter-mismatch) echo "$record"; echo '{"type":"DONE","status":"succeeded","records_emitted":2}' ;;
undeclared-stream) echo '{"type":"RECORD","stream":"other","key":"item-1","data":{"id":"item-1"},"emitted_at":"2026-07-30T00:00:00Z"}' ;;
extra-field) echo '{"type":"RECORD","stream":"items","key":"item-1","data":{"id":"item-1","source_updated_at":"2026-07-30T00:00:00Z","secret":"no"},"emitted_at":"2026-07-30T00:00:00Z"}' ;;
wrong-resource) echo '{"type":"RECORD","stream":"items","key":"item-2","data":{"id":"item-2","source_updated_at":"2026-07-30T00:00:00Z"},"emitted_at":"2026-07-30T00:00:00Z"}' ;;
compound-key) echo '{"type":"RECORD","stream":"items","key":["user-1","item-1"],"data":{"id":"item-1"},"emitted_at":"2026-07-30T00:00:00Z"}'; echo "$done" ;;
events) echo '{"type":"PROGRESS","stream":"items","message":"working","count":1,"total":1}'; echo '{"type":"SKIP_RESULT","stream":"items","reason":"rate_limited"}'; echo "$record"; echo "$done" ;;
interaction) echo '{"type":"INTERACTION","request_id":"login","kind":"credentials","message":"Log in"}' ;;
oversized-stdout) head -c 128 /dev/zero | tr '\000' x; echo ;;
oversized-stderr) head -c 128 /dev/zero | tr '\000' e >&2; echo "$record"; echo "$done" ;;
failed-done) echo '{"type":"DONE","status":"failed","records_emitted":0}'; exit 2 ;;
cancelled-done) echo '{"type":"DONE","status":"cancelled","records_emitted":0}'; exit 2 ;;
nonzero-success) echo "$record"; echo "$done"; exit 2 ;;
sleep) sleep 5 ;;
*) exit 72 ;;
esac
