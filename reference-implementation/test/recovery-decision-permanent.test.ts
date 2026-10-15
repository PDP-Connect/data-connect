// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * A `retryable: false` durable gap is permanent source loss. The pure recovery
 * governor must never classify it as recoverable work, source pressure, or an
 * owner/system retry, and the explicit discriminator must dominate every
 * conflicting hint (`last_error.class`, pressure-looking `reason`).
 *
 * Proposed vocabulary (pending lead approval, see checkpoint): recovery class
 * `permanent_loss` and admission denial reason `permanent_loss`. The existing
 * `system_issue` denial means "a connector defect or maintainer must act";
 * permanent source loss is neither, so it gets its own denial reason.
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyRecoveryGap,
  hasEligibleNonPressureRecovery,
  partitionRecoveryBacklog,
  type RecoveryGapRow,
  resolveRecoveryAdmission,
  summarizeRecoveryAdmissionDiagnostics,
} from "../runtime/recovery-decision.ts";

const NOW_MS = Date.parse("2026-10-15T00:00:00.000Z");

function row(overrides: Partial<RecoveryGapRow> & { retryable?: boolean | null }): RecoveryGapRow {
  return {
    attempt_count: 0,
    connector_id: "conn",
    connector_instance_id: "cin_1",
    next_attempt_after: null,
    reason: "temporary_unavailable",
    status: "pending",
    stream: "messages",
    ...overrides,
  } as RecoveryGapRow;
}

const PERMANENT = row({ reason: "source_unrepresentable", retryable: false });
const TRANSIENT = row({ reason: "temporary_unavailable", retryable: true });

test("retryable:false classifies as permanent_loss, never pressure or drainable recovery", () => {
  const classification = classifyRecoveryGap(PERMANENT);
  assert.equal(classification.recoveryClass, "permanent_loss");
  assert.equal(classification.isSourcePressure, false);
  assert.equal(classification.isNonPressureRecovery, false);
});

test("the explicit false dominates conflicting reason, class and cap hints", () => {
  for (const overrides of [
    { last_error: { class: "provider_pressure" }, reason: "rate_limited" },
    { last_error: { class: "run_cap_deferred" }, reason: "retry_exhausted" },
    { last_error: { class: "transient_no_progress" }, reason: "temporary_unavailable" },
    { detail_class: "provider_pressure", reason: "upstream_pressure" },
    { last_error: { class: "owner_required" }, reason: "auth_failure" },
  ]) {
    const conflicting = row({ ...overrides, retryable: false });
    assert.equal(classifyRecoveryGap(conflicting).recoveryClass, "permanent_loss", JSON.stringify(overrides));
    assert.equal(classifyRecoveryGap(conflicting).isSourcePressure, false);
    const admission = resolveRecoveryAdmission(conflicting, { domainCooldownActive: false, nowMs: NOW_MS });
    assert.equal(admission.ok, false);
  }
});

test("admission denies permanent loss with its own reason, not cooldown, budget or system_issue", () => {
  const admission = resolveRecoveryAdmission(PERMANENT, { nowMs: NOW_MS });
  assert.deepEqual(admission, { ok: false, reason: "permanent_loss" });
  // No timing floor can make it admissible, and an expired floor changes nothing.
  const pastFloor = resolveRecoveryAdmission(
    row({ next_attempt_after: "2020-01-01T00:00:00.000Z", retryable: false }),
    {
      nowMs: NOW_MS,
    }
  );
  assert.deepEqual(pastFloor, { ok: false, reason: "permanent_loss" });
});

test("a diagnostic not_retriable hint alone is NOT a guard", () => {
  const hintOnly = row({ last_error: { class: "not_retriable" }, reason: "retry_exhausted" });
  assert.equal(resolveRecoveryAdmission(hintOnly, { nowMs: NOW_MS }).ok, true);
  assert.notEqual(classifyRecoveryGap(hintOnly).recoveryClass, "permanent_loss");
});

test("legacy rows with null or absent retryable keep their old-contract classification and admission", () => {
  for (const legacy of [row({ reason: "retry_exhausted" }), row({ reason: "rate_limited", retryable: null })]) {
    assert.notEqual(classifyRecoveryGap(legacy).recoveryClass, "permanent_loss");
    assert.equal(resolveRecoveryAdmission(legacy, { nowMs: NOW_MS }).ok, true);
  }
  assert.equal(classifyRecoveryGap(row({ reason: "rate_limited", retryable: null })).isSourcePressure, true);
});

test("retryable:true rows behave exactly as before", () => {
  assert.equal(resolveRecoveryAdmission(TRANSIENT, { nowMs: NOW_MS }).ok, true);
  assert.equal(classifyRecoveryGap(TRANSIENT).isNonPressureRecovery, true);
});

test("partitioning sends permanent loss to blocked and never inflates pressure or non-pressure counts", () => {
  const backlog = partitionRecoveryBacklog([
    PERMANENT,
    row({ reason: "rate_limited", retryable: false }),
    TRANSIENT,
    row({ reason: "rate_limited", retryable: true }),
  ]);
  const [domain] = [...backlog.values()];
  assert.ok(domain);
  assert.equal(domain.blocked.length, 2, "both explicit-false rows are blocked");
  assert.equal(domain.pressure.length, 1, "only the retryable pressure row counts as pressure");
  assert.equal(domain.nonPressure.length, 1);
});

test("permanent loss cannot make a domain look like it has eligible recovery work", () => {
  const onlyPermanent = [...partitionRecoveryBacklog([PERMANENT]).values()][0];
  assert.equal(hasEligibleNonPressureRecovery(onlyPermanent, NOW_MS), false);
  const mixed = [...partitionRecoveryBacklog([PERMANENT, TRANSIENT]).values()][0];
  assert.equal(
    hasEligibleNonPressureRecovery(mixed, NOW_MS),
    true,
    "transient work is not starved by the permanent row"
  );
});

test("admission diagnostics report permanent loss distinctly and do not explain it as system_issue", () => {
  const onlyPermanent = summarizeRecoveryAdmissionDiagnostics([PERMANENT], { nowMs: NOW_MS });
  assert.equal(onlyPermanent.admitted, 0);
  assert.equal(onlyPermanent.deferred, 1);
  assert.equal(onlyPermanent.why_not_now, "permanent_loss");
  assert.equal(onlyPermanent.deferred_by_reason?.permanent_loss, 1);
  assert.equal(onlyPermanent.deferred_by_reason?.system_issue ?? 0, 0);

  const mixed = summarizeRecoveryAdmissionDiagnostics([PERMANENT, TRANSIENT], { nowMs: NOW_MS });
  assert.equal(mixed.admitted, 1);
  assert.equal(mixed.why_not_now, undefined, "eligible transient work means nothing needs explaining");
});
