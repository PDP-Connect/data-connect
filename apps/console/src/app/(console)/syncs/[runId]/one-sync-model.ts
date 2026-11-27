// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import { humanizeFieldLabel } from "@pdpp/display";
import type { SyncEntry } from "../../lib/ref-client.ts";
import { historyKindName, type HistorySource } from "../../history/source-names.ts";
import type { CurrentRunAssistance } from "../../lib/run-assistance.ts";
export interface OneSyncModel {
  id: string; name: string; connector: string; connection: string | null;
  at: string | null; started: string | null; completed: string | null;
  outcome: SyncEntry["outcome"] | "needs_you";
  currentSource?: import("../../history/source-names.ts").HistorySource;
  evidence?: import("../../lib/sync-cause.ts").SyncCauseEvidence;
  kindNames?: Record<string,string>;
  cause: string | null; rawError: string | null; trigger: string | null;
  total: number | null; kinds: { kind: string; count: number }[] | null;
  missing: { name: string; canRetry: boolean }[];
  assistance: CurrentRunAssistance | null; retryHref: string | null;
}
export function durationWords(started: string | null, completed: string | null): string | null {
  if (!(started && completed)) { return null; }
  const minutes = Math.max(0,Math.round((Date.parse(completed)-Date.parse(started))/60_000));
  if (minutes < 1) { return "a few seconds"; }
  if (minutes < 60) { return `${minutes} minute${minutes === 1 ? "" : "s"}`; }
  const hours = Math.floor(minutes/60); const rest = minutes%60;
  return `${hours} hour${hours === 1 ? "" : "s"}${rest ? ` ${rest} minute${rest === 1 ? "" : "s"}` : ""}`;
}
export function recordKindName(kind: string): string { return humanizeFieldLabel(kind); }
export function oneSyncPractice(state: string, now = Date.now()): OneSyncModel {
  const outcomes: Record<string,OneSyncModel["outcome"]> = { "could-not-start": "could_not_start", stopped: "stopped", interrupted: "interrupted", syncing: "syncing", "needs-you": "needs_you", "auth-failed": "failed", blocked: "failed", unfinished: "failed", failed: "failed", "expired-sign-in":"failed" };
  return { id: "practice-sync", name: "Northwind", connector: "northwind", connection: "practice-source-4", at: new Date(now-60_000).toISOString(), started: new Date(now-180_000).toISOString(), completed: ["syncing","needs-you"].includes(state) ? null : new Date(now-60_000).toISOString(), outcome: outcomes[state] ?? "finished", evidence:state==="expired-sign-in"?{reason:"connector_reported_failed",connector_error:{code:"session_expired"}}:undefined, cause: state === "auth-failed" ? "auth_failed" : state === "blocked" ? "auth_blocked" : state === "unfinished" ? "assistance_timed_out" : null, rawError: null, trigger: "scheduled", total: ["nothing","could-not-start"].includes(state) ? 0 : state==="recopied"?58_000:14, kinds: ["finished","missing","nothing"].includes(state) ? state === "nothing" ? [] : [{kind: "messages",count: 14}] : null, missing: state === "missing" ? [{ name: "Attachments", canRetry: true }] : [], assistance: null, retryHref: "/sources/practice-source-4" };
}

/** One name per kind of record, the same one the data source's own page uses. */
export function oneSyncKindNames(sources: HistorySource[], connection: string | null, kinds: string[]): Record<string,string> {
  return Object.fromEntries(kinds.map(kind=>[kind,historyKindName(sources,connection,kind)]));
}

const SAYS_SYNCING_OR_SYNCED = /^(?:Now: )?(?:Syncing|Synced)\b/;

/** A failed run says its cause once; the source's current line is shown only when it says something else. */
export function currentStateAddsToFailure(outcome: OneSyncModel["outcome"], causeSentence: string, currentState: string): boolean {
  if ((outcome === "syncing" || outcome === "finished") && SAYS_SYNCING_OR_SYNCED.test(currentState)) return false;
  return !(outcome === "failed" && currentState.includes(causeSentence));
}

/** What the totals under a run are called: after a failure that brought nothing, they are what came before. */
export function hereNowTitle(outcome: OneSyncModel["outcome"], thisSyncBroughtRecords: boolean): string {
  return outcome === "failed" && !thisSyncBroughtRecords ? "Already copied before this sync" : "What is here now";
}
