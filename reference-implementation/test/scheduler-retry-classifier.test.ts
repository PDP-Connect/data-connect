// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Mutation-killing unit coverage for `runtime/scheduler-retry-classifier.ts`,
 * which had no test importing it. This module decides whether a failed
 * connector run should be retried by the scheduler — a wrong verdict either
 * hammers a permanently-broken source or gives up on a transient blip.
 *
 * Branches pinned:
 *   - isRetryableHttpStatus: non-integer -> retryable; 4xx except 429 ->
 *     non-retryable; 429 / 5xx / 3xx / 2xx -> retryable; the 400 and 499
 *     window boundaries.
 *   - shouldRetryRunFailure: null/undefined err; the ordered short-circuit
 *     through http status -> failure_reason -> terminal_reason ->
 *     connector-reported failure (never retried) -> runtime verdict; and the
 *     default-retry fall-through for failures the runtime observed itself.
 *   - isTerminalGrantFailure: the four grant reasons vs non-members and
 *     null/undefined.
 *
 * These reason strings (grant_revoked, etc.) are compared only as opaque
 * classification labels; no grant/scope enforcement is exercised or changed —
 * this file only OBSERVES the classifier (per the RED test-only protocol).
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  isRetryableHttpStatus,
  isTerminalGrantFailure,
  NON_RETRYABLE_FAILURE_REASONS,
  NON_RETRYABLE_TERMINAL_REASONS,
  runRequiresOwnerAuthRepair,
  shouldRetryRunFailure,
  TERMINAL_GRANT_FAILURE_REASONS,
} from "../runtime/scheduler-retry-classifier.ts";

// ─── isRetryableHttpStatus ───────────────────────────────────────────────

test("isRetryableHttpStatus treats a non-integer status as retryable", () => {
  assert.equal(isRetryableHttpStatus(undefined), true);
  assert.equal(isRetryableHttpStatus(null), true);
  assert.equal(isRetryableHttpStatus("500"), true);
  assert.equal(isRetryableHttpStatus(Number.NaN), true);
});

test("isRetryableHttpStatus treats non-429 4xx as non-retryable", () => {
  assert.equal(isRetryableHttpStatus(400), false);
  assert.equal(isRetryableHttpStatus(404), false);
  assert.equal(isRetryableHttpStatus(418), false);
  assert.equal(isRetryableHttpStatus(499), false);
});

test("isRetryableHttpStatus keeps 429 retryable", () => {
  assert.equal(isRetryableHttpStatus(429), true);
});

test("isRetryableHttpStatus keeps 5xx, 3xx, and 2xx retryable", () => {
  assert.equal(isRetryableHttpStatus(500), true);
  assert.equal(isRetryableHttpStatus(503), true);
  assert.equal(isRetryableHttpStatus(302), true);
  assert.equal(isRetryableHttpStatus(200), true);
});

test("isRetryableHttpStatus boundary: 399 retryable, 400 not", () => {
  assert.equal(isRetryableHttpStatus(399), true);
  assert.equal(isRetryableHttpStatus(400), false);
});

// ─── shouldRetryRunFailure ───────────────────────────────────────────────

test("shouldRetryRunFailure is false for a null / undefined error", () => {
  assert.equal(shouldRetryRunFailure(null), false);
  assert.equal(shouldRetryRunFailure(undefined), false);
});

test("shouldRetryRunFailure defaults to retry for an empty / transient error", () => {
  assert.equal(shouldRetryRunFailure({}), true);
  assert.equal(shouldRetryRunFailure({ failure_reason: "temporary_network_error" }), true);
});

test("shouldRetryRunFailure honors a non-retryable http status first", () => {
  assert.equal(shouldRetryRunFailure({ response_status: 404 }), false);
  assert.equal(shouldRetryRunFailure({ response_status: 429 }), true);
  assert.equal(shouldRetryRunFailure({ response_status: 500 }), true);
});

test("shouldRetryRunFailure is false for every non-retryable failure_reason", () => {
  for (const reason of NON_RETRYABLE_FAILURE_REASONS) {
    assert.equal(shouldRetryRunFailure({ failure_reason: reason }), false, reason);
  }
});

test("shouldRetryRunFailure is false for every non-retryable terminal_reason", () => {
  for (const reason of NON_RETRYABLE_TERMINAL_REASONS) {
    assert.equal(shouldRetryRunFailure({ terminal_reason: reason }), false, reason);
  }
});

test("shouldRetryRunFailure honors an explicit connector_error.retryable === false", () => {
  assert.equal(shouldRetryRunFailure({ connector_error: { retryable: false } }), false);
  assert.equal(shouldRetryRunFailure({ connector_error: { retryable: false }, runtime_retryable: true }), false);
});

test("shouldRetryRunFailure honors an explicit runtime retryability verdict", () => {
  assert.equal(shouldRetryRunFailure({ runtime_retryable: true }), true);
  assert.equal(shouldRetryRunFailure({ runtime_retryable: false }), false);
  // Terminal classifications remain more authoritative than a transport hint.
  assert.equal(shouldRetryRunFailure({ runtime_retryable: true, terminal_reason: "authentication_error" }), false);
});

// Collection Profile 0.2.0, Section 5.11: `DONE.error.retryable` and a
// recovery hint are connector claims. A runtime MUST NOT start an automatic
// retry because of either.
test("shouldRetryRunFailure does not retry a connector-reported failure because of its retryable claim", () => {
  assert.equal(shouldRetryRunFailure({ connector_error: { retryable: true } }), false);
  assert.equal(shouldRetryRunFailure({ connector_error: {} }), false);
  assert.equal(
    shouldRetryRunFailure({
      connector_error: { message: "upstream 503", retryable: true },
      known_gaps: [{ kind: "run_failed", recovery_hint: { action: "retry_by_runtime", retryable: true } }],
    }),
    false
  );
});

test("shouldRetryRunFailure keeps retrying a failure the runtime observed itself", () => {
  // No DONE.error: a crash or an exit without DONE.
  assert.equal(shouldRetryRunFailure({ connector_error: null, failure_reason: "runtime_error" }), true);
  // A runtime-side network failure with a structured cause code.
  assert.equal(shouldRetryRunFailure({ connector_error: null, runtime_retryable: true }), true);
});

test("shouldRetryRunFailure keeps an owner-action gap non-retryable over connector retryability", () => {
  assert.equal(
    shouldRetryRunFailure({
      connector_error: { retryable: true },
      known_gaps: [{ kind: "run_failed", recovery_hint: { action: "manual_action_required", retryable: false } }],
    }),
    false
  );
});

test("shouldRetryRunFailure lets a non-fatal reason with a retryable status through", () => {
  // 429 status + an unknown reason not in either non-retryable set -> retry.
  assert.equal(
    shouldRetryRunFailure({ failure_reason: "rate_limited", response_status: 429, terminal_reason: null }),
    true
  );
});

test('a connector-declared retryable provider outage whose message contains "session_failed" is not retried in the same tick and is not marked as needing a sign-in', () => {
  // buildSessionEstablishTerminalError prefixes EVERY session-establishment
  // failure with `${name}_session_failed:`, retryable or not. The connector's
  // retryable claim no longer starts a retry (Section 5.11); the next
  // scheduled run collects again. It still keeps the "session_failed"
  // substring from marking the connection as needing a sign-in.
  const err = {
    connector_error: {
      message:
        "usaa_session_failed: source_unavailable: USAA reported its login system is currently unavailable after Next click.",
      retryable: true,
    },
    failure_reason: null,
    known_gaps: null,
    terminal_reason: null,
  };
  assert.equal(shouldRetryRunFailure(err), false);
  assert.equal(runRequiresOwnerAuthRepair(err), false);
});

test("shouldRetryRunFailure still denies a real session_required/session_expired auth failure", () => {
  assert.equal(
    shouldRetryRunFailure({
      connector_error: { message: "usaa_session_failed: usaa_session_required", retryable: false },
    }),
    false
  );
  assert.equal(
    shouldRetryRunFailure({
      connector_error: { message: "chatgpt_session_expired" },
    }),
    false
  );
});

// ─── isTerminalGrantFailure ──────────────────────────────────────────────

test("isTerminalGrantFailure is true only for the four terminal grant reasons", () => {
  for (const reason of TERMINAL_GRANT_FAILURE_REASONS) {
    assert.equal(isTerminalGrantFailure(reason), true, reason);
  }
  assert.deepEqual([...TERMINAL_GRANT_FAILURE_REASONS].sort(), [
    "grant_consumed",
    "grant_expired",
    "grant_invalid",
    "grant_revoked",
  ]);
});

test("isTerminalGrantFailure is false for non-members and nullish input", () => {
  assert.equal(isTerminalGrantFailure("authentication_error"), false);
  assert.equal(isTerminalGrantFailure("nope"), false);
  assert.equal(isTerminalGrantFailure(null), false);
  assert.equal(isTerminalGrantFailure(undefined), false);
});
