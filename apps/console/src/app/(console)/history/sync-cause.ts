// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
export interface SyncCauseEvidence { reason?: string | null; error?: string | null; connector_error?: unknown }
export interface SyncCause { sentence: string; action: "Sign in again" | "Try again"; known: boolean }
/** Stored evidence only. Raw text selects an authored sentence; it is never displayed. */
export function resolveSyncCause(evidence: SyncCauseEvidence, name: string): SyncCause {
  const values: string[] = [evidence.reason ?? "", evidence.error ?? ""];
  function visit(value: unknown, depth: number) {
    if (depth > 4 || !value) return;
    if (typeof value === "string") { values.push(value); try { visit(JSON.parse(value), depth+1); } catch { /* plain server message */ } }
    else if (Array.isArray(value)) for (const item of value) visit(item,depth+1);
    else if (typeof value === "object") for (const key of ["code","reason","message","cause","cause_chain"]) visit((value as Record<string,unknown>)[key],depth+1);
  }
  visit(evidence.connector_error,0);
  const text = values.join("\n").toLowerCase();
  if (/(?:^|[^a-z])(?:[a-z]+_)*session_(?:expired|inactive|required|failed)(?:$|[^a-z])|(?:session|sign-in) (?:is |was )?(?:no longer|not) active/.test(text)) return { sentence: `${name} asked for a new sign-in.`, action: "Sign in again", known: true };
  if (/\b(auth_failed|invalid_credentials|authentication_failed|login_failed|credential_invalid|credentials_invalid|stored_credential_rejected)\b/.test(text)) return { sentence: `${name} didn't accept the sign-in.`, action: "Sign in again", known: true };
  if (/\b(auth_blocked|login_blocked|access_denied)\b/.test(text)) return { sentence: `${name} didn't let DataConnect sign in.`, action: "Sign in again", known: true };
  if (/\b(interaction_timeout|assistance_timeout|assistance_timed_out|login_timeout)\b/.test(text)) return { sentence: "The sign-in wasn't finished.", action: "Try again", known: true };
  return { sentence: "Something went wrong while copying.", action: "Try again", known: false };
}
