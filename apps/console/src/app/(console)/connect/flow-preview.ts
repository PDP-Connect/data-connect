// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import type { FirstSyncFacts } from "./status/[connectionId]/first-sync-outcome.ts";
import type { ConnectionSetupStatus } from "../lib/ref-client.ts";

export const previewStates = {
  launch: ["opening", "could-not-open", "busy", "lost-contact"],
  browser: ["card", "card-plain", "card-error", "opening", "browser-step", "browser-code", "browser-code-rejected", "browser-trouble", "stop-question", "signed-in", "needs-details", "needs-details-rejected", "approve"],
  details: ["empty", "rejected"],
  status: ["copying", "needs-you", "connected-missing-some", "timed-out", "busy", "stopped", "failed", "never-started"],
  provider: ["plain", "already-have-one", "could-not-start"],
} as const;

/** Match the existing preview gate, before any reads or side effects. */
export function flowPreviewState(page: keyof typeof previewStates, query: { _preview?: string; _state?: string }): string | null {
  if (process.env.NODE_ENV === "production" || query._preview !== "1") return null;
  const states: readonly string[] = previewStates[page];
  const state = query._state;
  return state && states.includes(state) ? state : null;
}

// All made-up service, request, and result data lives here.
export const flowPreview = {
  connector: { connectorId: "northwind", displayName: "Northwind" },
  connectionId: "sample-account",
  runId: "sample-copy",
  accounts: [{ connectionId: "sample-account", displayName: "Northwind, home" }],
  detailsRejected: "Northwind did not accept those sign-in details. Try again.",
  message: "Sign in to Northwind to continue.",
  rejected: "Northwind did not accept that code. Try again.",
  startError: "The sign-in page could not be reached.",
  busyError: "The secure browser is busy. Try again in a moment.",
  fields: [{ format: "email" as const, label: "Northwind email", name: "email", required: true }, { format: "password" as const, label: "Northwind password", name: "password", required: true }],
  kinds: [{ count: 42, kind: "orders" }],
};

export function previewStatus(state: string): ConnectionSetupStatus {
  const copying = state === "copying";
  return {
    account_identity: null, connection_id: flowPreview.connectionId, connector_id: "northwind", created_at: null,
    credential: { captured_at: null, credential_kind: null, present: false, rotated_at: null },
    display_name: "Northwind", health_state: "healthy", import_receipt: null,
    last_error: state === "never-started" ? { reason: "browser_surface_start_failed: synthetic launch failure", remediation: "Try again." } : state === "failed" ? { reason: "The service could not be reached.", remediation: "Something went wrong while copying your data." } : null,
    object: "connection_setup_status", pending: copying, running: copying,
    run: { finished_at: null, records_emitted: null, reported_records_emitted: null, run_id: flowPreview.runId, started_at: null, status: state === "never-started" ? "surface_failed" : copying ? "active" : "completed" },
    setup_kind: "browser_session", setup_material: { captured_at: null, kind: "browser_session", label: "Sign-in", present: false },
    setup_state: copying ? "first_sync_running" : state === "needs-you" ? "awaiting_browser_login" : state === "connected-missing-some" ? "active" : "first_sync_failed",
    status: "active", terminal_setup_disposition: null, updated_at: null,
  };
}

export function previewFacts(state: string): FirstSyncFacts {
  return {
    kinds: state === "copying" || state === "never-started" ? null : flowPreview.kinds,
    schedule: null,
    signedIn: state === "copying",
    runStatus: state === "never-started" ? "surface_failed" : state === "busy" ? "deferred" : undefined,
    failureReason: state === "timed-out" ? "assistance_timed_out" : state === "stopped" ? "owner_cancelled" : null,
    gaps: state === "connected-missing-some" ? [{ kind: "skip_result", stream: "returns", reason: "unavailable", message: "Northwind could not send returns.", recovery_hint: { retryable: true } }] : [],
  };
}

export function previewBrowserMessage(state: string): string {
  if (state === "card-plain") return "";
  if (state === "approve") return "Approve this sign-in in the Northwind app on your phone.";
  if (state.startsWith("needs-details")) return "Enter your Northwind email and password.";
  if (state.startsWith("browser-code")) return "Enter the 6-digit code Northwind sent to your phone.";
  if (state === "card" || state === "card-error") return "Sign in with your Northwind email and password.";
  return "Finish signing in to Northwind in the page above.";
}
