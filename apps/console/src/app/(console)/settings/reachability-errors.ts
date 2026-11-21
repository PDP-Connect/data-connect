// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
// One table from each public error code to what the owner reads: what happened,
// then what to do. The code itself stays reachable under Details → Diagnostics.
// An unknown code gets the generic message.

// What the owner was doing when it failed. The fallback names that action, so
// a failed turn-off never says it couldn't turn on.
// "prepare" is getting a chosen way ready before Turn on: nothing has turned on yet.
export type ActionKind = "prepare" | "turn-on" | "turn-off" | "check" | "change";

const SUPPORT = "Try again, or copy the details for support.";
export const GENERIC_ERROR = `Remote access couldn't turn on. ${SUPPORT}`;
const GENERIC_BY_ACTION: Readonly<Record<ActionKind, string>> = {
  prepare: `We couldn't get this way ready. ${SUPPORT}`,
  "turn-on": GENERIC_ERROR,
  "turn-off": `Remote access couldn't turn off. It may still be on. ${SUPPORT}`,
  check: `We couldn't check remote access. ${SUPPORT}`,
  change: `That change didn't save. ${SUPPORT}`,
};
export const genericErrorFor = (action: ActionKind): string => GENERIC_BY_ACTION[action];

export const CLEANUP_UNCONFIRMED = "Couldn't confirm the service closed your address.";
const TRY_AGAIN = "Something changed while we were connecting. Try again.";
const SERVICE_DOWN = "DataConnect's background service isn't running. Quit and reopen DataConnect.";
export const SERVICE_DETAILS = "We couldn't load this service's details. Try again.";
const ALREADY_WORKING = "Remote access is already changing. Wait a moment, then try again.";
const STEP_GONE = "That step is no longer available. Reload this page and try again.";
const KEYCHAIN = "DataConnect couldn't use your saved sign-in details. Enter them again.";

export const ERROR_MESSAGES: Readonly<Record<string, string>> = {
  owner_password_required: "Set a password first. Remote access needs one so only you can sign in.",
  provider_unavailable: "Couldn't reach the service. It may be busy or down. Remote access did not turn on.",
  verification_failed: "The address isn't working from the internet yet. Try again.",
  proof_refresh_unsupported:
    "We can't confirm the address still works. Turn it off and on to get a fresh one.",
  consent_changed: "Details of this connection changed. Review them, then try again.",
  consent_expired: "Details of this connection changed. Review them, then try again.",
  consent_mismatch: "Details of this connection changed. Review them, then try again.",
  consent_required: SERVICE_DETAILS,
  consent_unknown: SERVICE_DETAILS,
  consent_kind_mismatch: SERVICE_DETAILS,
  consent_details_unavailable: SERVICE_DETAILS,
  configuration_stale: TRY_AGAIN,
  candidate_stale: TRY_AGAIN,
  draft_scope_mismatch: TRY_AGAIN,
  setup_scope_mismatch: TRY_AGAIN,
  route_generation_mismatch: TRY_AGAIN,
  ambiguous_selection: TRY_AGAIN,
  setup_action_unavailable: TRY_AGAIN,
  setup_configuration_inconsistent: TRY_AGAIN,
  clear_input_unavailable: TRY_AGAIN,
  configuration_migration_required: TRY_AGAIN,
  operation_recovery_unauthorized: TRY_AGAIN,
  draft_read_required: TRY_AGAIN,
  draft_read_unavailable: TRY_AGAIN,
  unsafe_state_path:
    "A DataConnect folder can be changed by other accounts on this computer. Fix its permissions to continue.",
  cleanup_unconfirmed: CLEANUP_UNCONFIRMED,
  setup_required: "A step is needed before remote access can turn on. Finish setup, then try again.",
  host_path_too_long: "DataConnect's data folder path is too long for remote access.",
  host_supervisor_unavailable: SERVICE_DOWN,
  host_runtime_unavailable: SERVICE_DOWN,
  service_unreachable: SERVICE_DOWN,
  host_policy_denied: "This computer's settings don't allow remote access.",
  remote_disconnect_acknowledgment_required:
    "Check the box to confirm you understand this page may disconnect, then try again.",
  operation_in_progress: ALREADY_WORKING,
  operation_conflict: ALREADY_WORKING,
  operation_superseded: ALREADY_WORKING,
  configuration_in_use: ALREADY_WORKING,
  cleanup_debt: "A previous address couldn't be confirmed closed. Turn it off first, then try again.",
  operation_not_found: STEP_GONE,
  review_not_found: STEP_GONE,
  draft_not_found: STEP_GONE,
  route_not_found: STEP_GONE,
  unsupported: "This way isn't supported on this computer.",
  requirements_unsatisfied: "This computer is missing something this way needs. Check what's missing, then try again.",
  artifact_integrity_failed: "A required download didn't pass its safety check. Try again.",
  invalid_input: "Something you entered isn't valid. Check it and try again.",
  secret_input_unavailable: KEYCHAIN,
  secret_reference_inconsistent: KEYCHAIN,
  secret_in_use: "Those sign-in details are still in use. Turn off remote access first.",
  secret_backend_locked: "The system keychain is locked. Unlock it, then try again.",
  secret_backend_unavailable: "DataConnect couldn't reach the system keychain. Try again.",
  // Not codes from the server: reasons a recovery check reports.
  public_operation_recovery_unavailable: "We can't check this automatically. Turn it off, then try again.",
  route_reconciliation_required: "We lost track of the address. It may still be on. Turn it off.",
  // Fallbacks the server maps everything else to.
  reachability_unavailable: GENERIC_ERROR,
  internal_error: GENERIC_ERROR,
  embedding_contract_unavailable: GENERIC_ERROR,
};

export type PublicError = {
  code: string;
  message: string;
  // The server's own sentence. Details only; it can use the old product words.
  serverMessage?: string;
};

export function publicError(code: string | undefined, serverMessage?: string, action: ActionKind = "turn-on"): PublicError {
  const known = code === undefined ? undefined : Object.hasOwn(ERROR_MESSAGES, code) ? ERROR_MESSAGES[code] : undefined;
  return {
    code: code ?? "reachability_unavailable",
    message: known ?? genericErrorFor(action),
    ...(serverMessage ? { serverMessage } : {}),
  };
}

/** A failure that carries the public code and message the card shows. */
export class ReachabilityFailure extends Error {
  readonly detail: PublicError;
  constructor(detail: PublicError) {
    super(detail.message);
    this.detail = detail;
  }
}
