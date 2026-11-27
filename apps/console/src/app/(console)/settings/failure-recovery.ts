// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
// What the owner sees for each failure: a status, the plain words, and one
// button (provider trouble also offers another way). The words live in
// reachability-errors.ts; this table adds the status and the button.
import { ERROR_MESSAGES, genericErrorFor, GENERIC_ERROR, type ActionKind } from "./reachability-errors.ts";

export type FailureStatus = "off" | "needs-action";
export type ButtonKind =
  | "try-again"
  | "try-another-way"
  | "turn-off-and-on"
  | "review"
  | "fix-permissions"
  | "copy-diagnostics"
  | "turn-off";
export type RecoveryButton = { kind: ButtonKind; label: string };

const BUTTONS: Readonly<Record<ButtonKind, RecoveryButton>> = {
  "try-again": { kind: "try-again", label: "Try again" },
  "try-another-way": { kind: "try-another-way", label: "Try another way" },
  "turn-off-and-on": { kind: "turn-off-and-on", label: "Turn off and on" },
  review: { kind: "review", label: "Review" },
  "fix-permissions": { kind: "fix-permissions", label: "Fix permissions" },
  // The desktop shell has no restart command the console can call, and the server
  // names no shorter data folder, so these two rows copy the details for support.
  "copy-diagnostics": { kind: "copy-diagnostics", label: "Copy diagnostics" },
  "turn-off": { kind: "turn-off", label: "Turn off" },
};

type Row = { status: FailureStatus; buttons: readonly ButtonKind[] };
const retry: Row = { status: "off", buttons: ["try-again"] };
const staleTry: Row = { status: "off", buttons: ["try-again"] };
const serviceDown: Row = { status: "needs-action", buttons: ["copy-diagnostics"] };
const changed: Row = { status: "needs-action", buttons: ["review"] };

const TABLE: Readonly<Record<string, Row>> = {
  owner_password_required: { status: "off", buttons: [] },
  provider_unavailable: { status: "off", buttons: ["try-again", "try-another-way"] },
  verification_failed: { status: "needs-action", buttons: ["try-again"] },
  proof_refresh_unsupported: { status: "needs-action", buttons: ["turn-off-and-on"] },
  consent_changed: changed,
  consent_expired: changed,
  consent_mismatch: changed,
  configuration_stale: staleTry,
  candidate_stale: staleTry,
  unsafe_state_path: { status: "needs-action", buttons: ["fix-permissions"] },
  host_path_too_long: serviceDown,
  host_supervisor_unavailable: serviceDown,
  host_runtime_unavailable: serviceDown,
  service_unreachable: serviceDown,
  route_reconciliation_required: { status: "needs-action", buttons: ["turn-off"] },
  cleanup_unconfirmed: { status: "needs-action", buttons: ["try-again"] },
  cleanup_debt: { status: "needs-action", buttons: ["turn-off"] },
  reachability_unavailable: retry,
  internal_error: retry,
};

export const RECOVERY_CODES: readonly string[] = Object.keys(TABLE);

export type Recovery = { status: FailureStatus; message: string; buttons: RecoveryButton[] };

/** Anything not in the table reads as "Anything else": Off, the generic sentence, Try again. */
export function recoveryFor(code: string | undefined, action: ActionKind = "turn-on"): Recovery {
  const row = code !== undefined && Object.hasOwn(TABLE, code) ? TABLE[code] : undefined;
  const known = code !== undefined && Object.hasOwn(ERROR_MESSAGES, code) ? ERROR_MESSAGES[code] : undefined;
  const message = known === undefined ? genericErrorFor(action) : known === GENERIC_ERROR ? genericErrorFor(action) : known;
  const chosen = row ?? retry;
  return { status: chosen.status, message, buttons: chosen.buttons.map((kind) => BUTTONS[kind]) };
}
