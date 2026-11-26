// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import { humanizeFieldLabel } from "@pdpp/display";
import type { SyncEntry } from "../../lib/ref-client.ts";
import type { CurrentRunAssistance } from "../../lib/run-assistance.ts";
export interface OneSyncModel {
  id: string; name: string; connector: string; connection: string | null;
  at: string | null; started: string | null; completed: string | null;
  outcome: SyncEntry["outcome"] | "needs_you";
  evidence?: import("../../history/sync-cause.ts").SyncCauseEvidence;
  kindNames?: Record<string,string>;
  cause: string | null; rawError: string | null; trigger: string | null;
  total: number | null; kinds: { kind: string; count: number }[] | null;
  missing: { name: string; canRetry: boolean }[];
  assistance: CurrentRunAssistance | null; retryHref: string | null;
}
export function durationWords(started: string | null, completed: string | null): string | null {
  if (!started || !completed) return null;
  const minutes = Math.max(0,Math.round((Date.parse(completed)-Date.parse(started))/60_000));
  if (minutes < 1) return "a few seconds";
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  const hours = Math.floor(minutes/60); const rest = minutes%60;
  return `${hours} hour${hours === 1 ? "" : "s"}${rest ? ` ${rest} minute${rest === 1 ? "" : "s"}` : ""}`;
}
export function recordKindName(kind: string): string { return humanizeFieldLabel(kind); }
export function oneSyncPractice(state: string, now = Date.now()): OneSyncModel {
  const outcomes: Record<string,OneSyncModel["outcome"]> = { "could-not-start": "could_not_start", stopped: "stopped", interrupted: "interrupted", syncing: "syncing", "needs-you": "needs_you", "auth-failed": "failed", blocked: "failed", unfinished: "failed", failed: "failed", "expired-sign-in":"failed" };
  return { id: "practice-sync", name: "Northwind", connector: "northwind", connection: "practice-source-4", at: new Date(now-60_000).toISOString(), started: new Date(now-180_000).toISOString(), completed: ["syncing","needs-you"].includes(state) ? null : new Date(now-60_000).toISOString(), outcome: outcomes[state] ?? "finished", evidence:state==="expired-sign-in"?{reason:"connector_reported_failed",connector_error:{code:"session_expired"}}:undefined, cause: state === "auth-failed" ? "auth_failed" : state === "blocked" ? "auth_blocked" : state === "unfinished" ? "assistance_timed_out" : null, rawError: null, trigger: "manual", total: state === "nothing" ? 0 : state==="recopied"?58000:14, kinds: ["finished","missing","nothing"].includes(state) ? state === "nothing" ? [] : [{kind: "messages",count: 14}] : null, missing: state === "missing" ? [{ name: "Attachments", canRetry: true }] : [], assistance: null, retryHref: "/sources/practice-source-4" };
}
