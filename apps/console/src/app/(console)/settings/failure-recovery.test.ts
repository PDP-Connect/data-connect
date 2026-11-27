// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
// One table from each failure to its status, its words and its one button.
import assert from "node:assert/strict";
import test from "node:test";
import { RECOVERY_CODES, recoveryFor } from "./failure-recovery.ts";
import { ERROR_MESSAGES, GENERIC_ERROR } from "./reachability-errors.ts";

type Row = { code: string; status: "off" | "needs-action"; message: RegExp; buttons: string[] };
const rows: Row[] = [
  { code: "owner_password_required", status: "off", message: /Set a password first/, buttons: [] },
  { code: "provider_unavailable", status: "off", message: /Remote access did not turn on\./, buttons: ["Try again", "Try another way"] },
  { code: "verification_failed", status: "needs-action", message: /address isn't working from the internet yet/, buttons: ["Try again"] },
  { code: "proof_refresh_unsupported", status: "needs-action", message: /Turn it off and on to get a fresh one/, buttons: ["Turn off and on"] },
  { code: "consent_changed", status: "needs-action", message: /Details of this connection changed/, buttons: ["Review"] },
  { code: "consent_expired", status: "needs-action", message: /Details of this connection changed/, buttons: ["Review"] },
  { code: "configuration_stale", status: "off", message: /Something changed while we were connecting\. Try again\./, buttons: ["Try again"] },
  { code: "candidate_stale", status: "off", message: /Something changed while we were connecting\. Try again\./, buttons: ["Try again"] },
  { code: "unsafe_state_path", status: "needs-action", message: /A DataConnect folder can be changed by other accounts on this computer\. Fix its permissions to continue\./, buttons: ["Fix permissions"] },
  { code: "host_path_too_long", status: "needs-action", message: /data folder path is too long for remote access\./, buttons: ["Copy diagnostics"] },
  { code: "host_supervisor_unavailable", status: "needs-action", message: /background service isn't running\. Quit and reopen DataConnect\./, buttons: ["Copy diagnostics"] },
  { code: "host_runtime_unavailable", status: "needs-action", message: /background service isn't running\. Quit and reopen DataConnect\./, buttons: ["Copy diagnostics"] },
  { code: "route_reconciliation_required", status: "needs-action", message: /We lost track of the address\. It may still be on\./, buttons: ["Turn off"] },
  { code: "cleanup_unconfirmed", status: "needs-action", message: /Couldn't confirm .* closed your address\./, buttons: ["Try again"] },
  { code: "reachability_unavailable", status: "off", message: /couldn't turn on\. Try again, or copy the details for support\./, buttons: ["Try again"] },
  { code: "internal_error", status: "off", message: /couldn't turn on\. Try again, or copy the details for support\./, buttons: ["Try again"] },
];

test("every failure row has its status, copy and one button", () => {
  for (const row of rows) {
    const found = recoveryFor(row.code);
    assert.equal(found.status, row.status, row.code);
    assert.match(found.message, row.message, row.code);
    assert.deepEqual(found.buttons.map((button) => button.label), row.buttons, row.code);
  }
});

test("an unknown code reads as Anything else", () => {
  const found = recoveryFor("brand_new_code");
  assert.equal(found.message, GENERIC_ERROR);
  assert.equal(found.status, "off");
  assert.deepEqual(found.buttons.map((button) => button.label), ["Try again"]);
});

test("no code or snake_case word appears in any main text", () => {
  for (const code of [...RECOVERY_CODES, "brand_new_code"]) {
    const { message, buttons } = recoveryFor(code);
    for (const text of [message, ...buttons.map((button) => button.label)]) {
      assert.doesNotMatch(text, /\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/, `${code}: ${text}`);
      assert.doesNotMatch(text, /reachability/i, `${code}: ${text}`);
    }
  }
});

test("every §10 row is in the table, and each table code has copy", () => {
  for (const row of rows) assert.ok(RECOVERY_CODES.includes(row.code) || row.code === "internal_error" || row.code === "reachability_unavailable", row.code);
  for (const code of RECOVERY_CODES) assert.ok(Object.hasOwn(ERROR_MESSAGES, code), code);
});
