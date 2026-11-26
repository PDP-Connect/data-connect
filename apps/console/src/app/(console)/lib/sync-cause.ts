// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
export interface SyncCauseEvidence { reason?: string | null; error?: string | null; connector_error?: unknown }
export interface SyncCause { sentence: string; action: "Sign in again" | "Try again" | null; known: boolean }
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
  if (/\b(?:rate_limited|upstream_pressure)\b/.test(text)) return { sentence: `${name} asked DataConnect to slow down. DataConnect tries again at the next check.`, action: null, known: true };
  if (/\bstatic_secret_credential_unavailable\b/.test(text)) return { sentence: `DataConnect could not find the saved sign-in details for ${name}.`, action: "Sign in again", known: true };
  if (/\b(?:surface_start_failed|headed_browser_unavailable)\b|browsertype\.launch/.test(text)) return { sentence: "DataConnect could not start its browser. DataConnect tries again at the next check.", action: null, known: true };
  if (/\bingest_endpoint_saturated\b/.test(text)) return { sentence: "DataConnect could not save the copies because its storage was busy. DataConnect tries again at the next check.", action: null, known: true };
  if (/\bingest_http_error\b/.test(text)) return { sentence: "DataConnect could not save the copies because its storage refused them. This needs a fix from the people who maintain DataConnect.", action: null, known: true };
  if (/\bconnector_protocol_violation\b/.test(text)) return { sentence: `The connector for ${name} sent something DataConnect could not accept. This needs a fix from the people who maintain DataConnect.`, action: null, known: true };
  if (/\b(?:econnrefused|econnreset|enotfound|eai_again|etimedout)\b/.test(text)) return { sentence: `DataConnect could not reach everything it needs to sync ${name}. DataConnect tries again at the next check.`, action: null, known: true };
  if (/\bconnector_exit_without_done\b/.test(text)) return { sentence: `The connector for ${name} stopped before reporting its result. DataConnect tries again at the next check.`, action: null, known: true };
  if (/\bstream_collection_failed\b/.test(text)) return { sentence: `DataConnect could not copy some records from ${name}.`, action: "Try again", known: true };
  if (/\bvenmo_login_incomplete_after_submit\b/.test(text)) return { sentence: "The sign-in wasn't finished.", action: "Try again", known: true };
  if (/\blaunch_failed\b/.test(text)) return { sentence: `DataConnect could not start the connector for ${name}. DataConnect tries again at the next check.`, action: null, known: true };
  if (/\bcontroller_restarted\b/.test(text)) return { sentence: "DataConnect restarted before the sync finished. DataConnect tries again at the next check.", action: null, known: true };
  if (/\brun_timed_out\b/.test(text)) return { sentence: "DataConnect stopped the sync because it took too long. DataConnect tries again at the next check.", action: null, known: true };
  return { sentence: `Something stopped ${name} from syncing.`, action: "Try again", known: false };
}

export function copiedRecords(count: number): string {
  return count === 0 ? "Nothing to copy" : `copied ${count.toLocaleString("en-US")} record${count === 1 ? "" : "s"}`;
}
