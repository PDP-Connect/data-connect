# An observation mechanism must never destroy the thing it observes

Status: adopted. Enforced by tests in `src-tauri/src/unified.rs`.

Acting on what a health check reports is a decision for whatever owns the
resource, not for the check. Wiring a check directly to a destructive action
turns every inaccuracy in that check into an outage. This cost a day of
debugging on 2026-09-21, in two shapes.

## Two incidents

**#208 declared a healthy console unhealthy.** The readiness check fetched the
console's page, took the first `/_next/` asset it referenced, and required
that asset to resolve. On an unauthenticated launch the console serves
`/owner/login`, server-rendered HTML from
`reference-implementation/server/hosted-ui.ts` with no `/_next/` reference at
all, so the check found nothing and called that failure. Its failure path
reached `teardown_managed_on_error`, which stopped both the console and the
reference implementation, restarted them, and stopped them again. Three
consoles started and died in one session. Each one was working.

**`wait_for_console` would kill a slow console for being slow.** #216 fixed
the check above, but the same shape survived one level up: a fixed 45-second
budget, no retry, and an unconditional teardown when it expired. A console
needing longer than one round gets destroyed, which makes the next attempt
worse rather than better, because it restarts from nothing instead of from a
console that was nearly up.

Neither defect is the asset heuristic or the timeout value. Tuning either
would leave the shape intact.

## What this requires

1. A check returns a value rather than acting on its subject.
2. A timeout means "has not answered yet", which is not "is broken". Retry
   with backoff before concluding anything.
3. A check that cannot apply to what it is looking at reports unknown, not
   unhealthy. A non-Next page and an unauthenticated route are both cases
   where a missing asset proves nothing. Unknown must not render as healthy
   either.
4. Stop something only when waiting provably cannot help, meaning the process
   is gone or a generous budget is spent, and leave that call to whatever owns
   the resource.

## How it is enforced

Each observer carries a source-level test, rather than relying on review,
asserting its body cannot reach `teardown`, `teardown_managed_on_error`,
`app.exit`, `set_status`, or `request_shutdown`:

- `spawn_console_deep_health_watch`, the deep multi-route check (#216)
- `spawn_origin_verification_watcher`, the tunnel reachability probe
- `wait_for_console_with_retry`, the readiness wait (#218), which is the one
  path that still legitimately gates startup, so it reports and retries and
  leaves teardown to its caller

A runtime test would need a real `AppHandle`, which this file's other tests
document as unavailable in the harness, so the guarantee is pinned at the
source level. Each test has been confirmed to fail when a destructive call is
introduced into the function it guards.

Adding a new health check, watcher, or readiness probe means adding the same
test. If that test is awkward to write because the check genuinely needs to
stop something, split it: a liveness gate the owner consults, and a diagnostic
that only reports.

## Related

- `docs/architecture.md`, the supervisor and sidecar lifecycle this governs.
- `OriginVerification` in the same file records when a reading was taken, so a
  stale one decays to unknown instead of reading as healthy. The two rules are
  duals: do not claim what you have not observed, and do not change what you
  are observing.
