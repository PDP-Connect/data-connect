// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { substituteCommandTemplate } from "../../../lib/pdpp-cli-command.ts";
import { resolveSyncCause } from "./sync-cause.ts";
import { personDay } from "../history/day-cut.ts";
import { formatConnectorKeyForDisplay, formatRelative } from "@pdpp/display";
import type { RefConnectorSummary, RefRequiredAction } from "./ref-client.ts";
import { summarizeOutboxStallRemediation } from "./connection-evidence.ts";
import { projectSourceActionability } from "./source-actionability.ts";

export type SourceStatusRow =
  | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12
  | 13 | 14 | 15 | 16 | 17 | 18 | 19 | 20 | 21 | 22 | 23 | 24;
export type SourceStatusTone = "plain" | "attention" | "accent" | "faint";
export type SourceStatusActionKind =
  | "continue_setup"
  | "set_up_again"
  | "install"
  | "review_setup"
  | "retry_first_sync"
  | "review_result"
  | "server_cta"
  | "resume"
  | "repair_sign_in"
  | "repair_credential"
  | "sync_now"
  | "view_device";

export interface SourceStatusAction {
  kind: SourceStatusActionKind;
  label: string;
  filled: boolean;
}

export interface SourceStatusWords {
  row: SourceStatusRow;
  words: string;
  tone: SourceStatusTone;
  action: SourceStatusAction | null;
  /** True when the shared answer offers a next step for the person. */
  needsYou: boolean;
}

const FINAL_STOP = /\.$/;
const BROWSER_SIGN_IN_SUFFIX = / \(Browser Sign-In\)$/i;
type MatchedStatus = Omit<SourceStatusWords, "needsYou"> & { sentence: SourceStateSentence; problem: boolean };

export interface SourceAnswer extends SourceStatusWords { sentence: SourceStateSentence; problem: boolean }

/** A sentence for the data source's own page. `slot` names a fact only the page holds. */
export interface SourceStateSentence {
  text: string;
  slot: "what_is_kept_and_what_set_up_again_does" | "what_you_can_do" | null;
}

export interface SourceStatusOptions {
  now: Date;
  /**
   * Whether the data source's own page has an address where the person can
   * update its sign-in. Only that page knows (it reads the connector's setup
   * needs). Elsewhere, a paused archive uses the shared "Continue" label and
   * links to the page, which then decides.
   */
  offset?: number;
  pendingDetails?: boolean;
  signInRepairAvailable?: boolean;
}

const DAY_MS = 24 * 60 * 60 * 1000;

function lastSuccessfulSync(source: RefConnectorSummary): string | null {
  return source.connection_health.last_success_at ?? source.last_successful_run?.last_at ?? null;
}

function formatWhen(value: string | null, now: Date, offset = -now.getTimezoneOffset()): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;

  const age = now.getTime() - date.getTime();
  if (age < 0) return "just now";
  if (age < 7 * DAY_MS) return formatRelative(date, now.getTime());

  const readerDate = new Date(`${personDay(value,offset)}T12:00:00Z`);
  const sameYear = personDay(value,offset).slice(0,4) === personDay(now.getTime(),offset).slice(0,4);
  return new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "short",
    ...(sameYear ? {} : { year: "numeric" }),
    timeZone: "UTC",
  }).format(readerDate);
}

function action(kind: SourceStatusActionKind, label: string, filled: boolean): SourceStatusAction {
  return { kind, label, filled };
}

function ownerAction(source: RefConnectorSummary): RefRequiredAction | null {
  return source.rendered_verdict?.required_actions.find((item) => item.audience === "owner") ?? null;
}

function canStartSync(source: RefConnectorSummary): boolean {
  return source.source_kind !== "local_device" &&
    source.source_kind !== "manual" &&
    source.connector_implementation?.state !== "not_installed" &&
    source.status !== "paused" &&
    source.status !== "revoked" &&
    source.source_visibility !== "setup_failed" &&
    !source.revoked_at;
}

function syncAction(source: RefConnectorSummary): SourceStatusAction | null {
  if (source.source_kind === "local_device") return action("view_device", "View this device", false);
  return canStartSync(source) ? action("sync_now", "Sync now", false) : null;
}

export function sourceNeverConnected(source: RefConnectorSummary): boolean {
  return source.source_visibility === "setup_failed";
}

// These are the two exact CTAs authored only by the unmeasured-completeness
// branch in runtime/rendered-verdict.ts. Unknown or changed server copy stays
// on the maintainer path; never infer this exception from code_fix alone.
function onlyUnmeasuredCompleteness(source: RefConnectorSummary): boolean {
  const actions = source.rendered_verdict?.required_actions ?? [];
  const item = actions[0];
  return Boolean(lastSuccessfulSync(source)) &&
    (!source.last_run || ["succeeded", "completed", "success", "succeeded_with_gaps"].includes(source.last_run.status)) &&
    actions.length === 1 &&
    item?.audience === "maintainer" && item.kind === "code_fix" && !item.terminal &&
    item.satisfied_when.kind === "none" && item.surface?.kind === "maintainer" &&
    (item.cta === "Some data from this source isn't being measured yet" ||
      item.cta === "Some data from this source ended before it could be measured, and this one-time import will not run again");
}

function lifecycleRow(
  source: RefConnectorSummary,
  projection: ReturnType<typeof projectSourceActionability>,
  options: SourceStatusOptions
): MatchedStatus | null {
  const {signInRepairAvailable} = options;
  const name = (source.connector_display_name || formatConnectorKeyForDisplay(source.connector_id)).replace(BROWSER_SIGN_IN_SUFFIX, "");
  const when = formatWhen(lastSuccessfulSync(source), options.now, options.offset);
  if (projection.renderedStatus.kind === "archived") return { row: 1, words: "Archived", tone: "faint", action: null , sentence: { text: "Archived. It no longer syncs. Your records are kept.", slot: null }, problem: false };
  if (projection.renderedStatus.kind === "setup_failed") {
    const text = sourceNeverConnected(source) ? `${name} was never connected.` : "Setup was never completed.";
    return {row:2,words:text,tone:"faint",action:action("continue_setup","Set up again",true),sentence:{text,slot:null},problem:true};
  }
  if (projection.revoked) return { row: 3, words: "Disconnected", tone: "faint", action: action("set_up_again", "Set up again", false) , sentence: { text: "Disconnected. Your records stay.", slot: null }, problem: false };
  if (source.connector_implementation?.state === "not_installed") {
    return { row: 4, words: "Needs installing again", tone: "attention", action: action("install", "Install again", true) , sentence: { text: `DataConnect needs to install ${name} again before it can sync.`, slot: null }, problem: true };
  }

  switch (source.terminal_setup_disposition) {
    case "unverified_missing_counts": {
      const serverAction = ownerAction(source);
      const renderableServerAction = serverAction && serverAction.satisfied_when.kind !== "none";
      const fallbackAction = source.source_kind === "local_device"
        ? syncAction(source)
        : source.status === "paused"
          ? action("resume", "Resume", false)
          : syncAction(source);
      const firstSyncAction = fallbackAction?.kind === "sync_now"
        ? { ...fallbackAction, label: "Retry first sync" }
        : fallbackAction;
      return {
        row: 5,
        words: "First sync needs a look",
        tone: "attention",
        action: renderableServerAction
          ? action("review_setup", "Review setup", true)
          : firstSyncAction ? { ...firstSyncAction, filled: true } : null,
      sentence: { text: `The first copy of ${name} may not be complete.`, slot: "what_you_can_do" }, problem: true };
    }
    case "unverified_zero":
      return { row: 6, words: "First sync found no records", tone: "attention", action: action("retry_first_sync", "Retry first sync", true) , sentence: { text: "First sync found no records.", slot: "what_you_can_do" }, problem: true };
    case "verified_empty":
      return { row: 7, words: "No records found", tone: "plain", action: action("review_result", "Review result", false) , sentence: { text: "No records found.", slot: "what_you_can_do" }, problem: false };
  }

  const resolver = source.owner_state?.resolver;
  if (projection.paused) {
    // A recovered archive usually has no sign-in on this server, so resuming it
    // alone makes the next sync fail. Updating the sign-in resumes it too (the
    // server resumes a paused archive when it saves the sign-in). Resume is the
    // next step only when there is no sign-in to update.
    const pausedAction = source.source_kind === "local_device"
      ? action("view_device", "View this device", false)
      : source.source_binding_kind === "historical_archive"
        ? signInRepairAvailable === false
          ? action("resume", "Resume", false)
          : action("repair_credential", "Resume", false)
        : action("resume", "Resume", false);
    return { row: 10, words: "Paused", tone: "faint", action: pausedAction , sentence: { text: source.source_kind === "local_device" ? `Paused on ${source.local_device_progress?.device_name ?? "the computer that holds this data"}. Resume it there.` : source.status === "paused" ? `Paused. Your records${options.signInRepairAvailable ? " and sign-in" : ""} are kept.${when ? ` Last synced ${when}.` : ""}` : `Automatic sync is off.${when ? ` Last synced ${when}.` : ""}`, slot: null }, problem: false };
  }
  if (resolver === "needs_owner") {
    const requiredAction = ownerAction(source);
    const surface = requiredAction?.surface?.kind;
    // A collector on another computer owns this data: its answer is the
    // device sentence and next step even when the server names no owner step.
    const isDevice = surface === "local_device" || source.source_kind === "local_device";
    if (isDevice && source.local_device_progress?.records_pending === 0) {
      return { row: 20, words: "No records are waiting to be sent", tone: "plain", action: null , sentence: { text: "No records are waiting to be sent.", slot: null }, problem: false };
    }
    const unknownStep = surface === "provider_interaction" && (!requiredAction?.target || requiredAction.cta === "Complete the requested action");
    const devicePending = source.local_device_progress?.records_pending;
    const deviceName = source.local_device_progress?.device_name;
    const deviceHasSteps = Boolean(requiredAction?.remediation?.commands.some(command=>substituteCommandTemplate(command.command_template,{connectionId:source.connection_id,connectorId:source.connector_id,sourceInstanceId:source.local_device_progress?.source_instance_id ?? null,providerUrl:null}) !== null)) ||
      (!requiredAction?.remediation && summarizeOutboxStallRemediation(source.connection_health, source.local_device_progress) !== null);
    const deviceText = deviceHasSteps && typeof devicePending === "number" && devicePending > 0
      ? `The computer that holds this data${deviceName ? ` (${deviceName})` : ""} could not send ${devicePending.toLocaleString()} record${devicePending === 1 ? "" : "s"}.`
      : `Open DataConnect on ${deviceName ?? "the computer that holds this data"} and look for a message about ${name}.`;
    const sentence = isDevice ? deviceText : unknownStep || !requiredAction ? `Something stopped ${name} from syncing.` : surface === "browser_session" ? `${name} needs you to sign in again.` : surface === "stored_credential" ? `${name} needs its saved sign-in details updated.` : `${name} is waiting for you to finish a step.`;
    const words = isDevice ? deviceText.replace(FINAL_STOP, "") : unknownStep || !requiredAction ? `Something stopped ${name} from syncing.` : surface === "browser_session"
      ? "Needs you to sign in again"
      : surface === "stored_credential"
        ? "Needs its saved sign-in details updated"
        : surface === "provider_interaction"
          ? "Waiting for you to finish a step"
          : "Needs you";
    return {
      row: 8,
      words,
      sentence: {text:sentence,slot:null}, problem:true,
      tone: "attention",
      action: isDevice ? (deviceHasSteps ? action("server_cta", "See what to do on that computer", true) : null) : unknownStep || !requiredAction ? (canStartSync(source) ? action("sync_now", "Try again", true) : null) : requiredAction ? action("server_cta", surface === "stored_credential" ? "Update sign-in details" : requiredAction.cta, true) : null,
    };
  }
  if (resolver === "setup_in_progress") {
    return { row: 9, words: "Setup in progress", tone: "attention", action: action("continue_setup", "Continue setup", true) , sentence: { text: "Setup is in progress.", slot: null }, problem: true };
  }
  if (resolver === "collecting" || (!source.owner_state && projection.renderedStatus.kind === "pending")) {
    return { row: 11, words: "Syncing now", tone: "accent", action: null , sentence: { text: `Syncing now.${source.last_run && ["pending","started","in_progress","running"].includes(source.last_run.status) && source.last_run.started_at ? ` Started ${formatWhen(source.last_run.started_at, options.now)}.` : ""}`, slot: null }, problem: false };
  }
  return null;
}

function fallbackPillRow(source: RefConnectorSummary, options: SourceStatusOptions): MatchedStatus | null {
  const name = (source.connector_display_name || formatConnectorKeyForDisplay(source.connector_id)).replace(BROWSER_SIGN_IN_SUFFIX, "");
  const label = source.rendered_verdict?.pill.label;
  if (!label) return null;
  const when = formatWhen(lastSuccessfulSync(source), options.now, options.offset);
  const withWhen = (prefix: string) => when ? `${prefix} · last synced ${when}` : prefix;
  if (label === "Missing optional data") return { row: 14, words: withWhen("Some optional data is missing"), tone: "plain", action: null , sentence: { text: `${(withWhen("Some optional data is missing")) .replace(FINAL_STOP, "")}.`, slot: null }, problem: true };
  if (label === "Some records stuck") return { row: 15, words: withWhen("Some records are stuck"), tone: "plain", action: null , sentence: { text: `${(withWhen("Some records are stuck")) .replace(FINAL_STOP, "")}.`, slot: null }, problem: true };
  if (label === "Missing data" || label === "Can't collect") return { row: 16, words: withWhen("Trouble syncing"), tone: "plain", action: null , sentence: { text: withWhen("Trouble syncing"), slot: null }, problem: true };
  if (label === "Import complete") return { row: 18, words: when ? `Imported ${when}` : "Imported", tone: "plain", action: null , sentence: { text: `${when ? `Imported ${when}` : "Imported"}. This was a one-time import; it does not sync on its own.`, slot: null }, problem: false };
  if (label === "Needs refresh") return { row: 17, words: withWhen("A refresh is due"), tone: "plain", action: syncAction(source) , sentence: { text: `A refresh is due.${when ? ` Last synced ${when}.` : ""}`, slot: null }, problem: false };
  if (label === "Not measured") {
    if (lastSuccessfulSync(source)) return { row: 21, words: when ? `Synced ${when}` : "Synced", tone: "plain", action: null , sentence: { text: `Synced${when ? ` ${when}` : ""}. DataConnect has not compared this with ${name} yet.`, slot: null }, problem: false };
    return { row: 23, words: source.source_kind === "manual" ? "Nothing imported yet" : "Not synced yet", tone: "plain", action: syncAction(source) , sentence: { text: source.source_kind === "manual" && !lastSuccessfulSync(source) ? "Nothing imported yet. Add an export to copy your records." : `${(source.source_kind === "manual" ? "Nothing imported yet" : "Not synced yet") .replace(FINAL_STOP, "")}.`, slot: null }, problem: false };
  }
  if (label === "Healthy" || label === "Collected, not independently checked") {
    return { row: 20, words: when ? `Synced ${when}` : "Synced", tone: "plain", action: null , sentence: { text: source.local_device_progress?.records_pending === 0 && source.owner_state?.resolver === "needs_owner" ? "No records are waiting to be sent." : `Synced${when ? ` ${when}` : ""}.${source.connection_health.lateness?.state === "late" || source.connection_health.lateness?.state === "overdue" ? " The next sync is late." : ""}${source.owner_state?.posture === "frozen-since-last-run" ? ` DataConnect has not compared this with ${name} yet.` : ""}`, slot: null }, problem: false };
  }
  return { row: 23, words: "Status not available", tone: "faint", action: null , sentence: { text: source.source_kind === "manual" && !lastSuccessfulSync(source) ? "Nothing imported yet. Add an export to copy your records." : `${("Status not available") .replace(FINAL_STOP, "")}.`, slot: null }, problem: false };
}

function matchSourceStatus(source: RefConnectorSummary, options: SourceStatusOptions): MatchedStatus {
  const name = (source.connector_display_name || formatConnectorKeyForDisplay(source.connector_id)).replace(BROWSER_SIGN_IN_SUFFIX, "");
  const projection = projectSourceActionability(source);
  const lifecycle = lifecycleRow(source, projection, options);
  if (lifecycle) return lifecycle;

  const resolver = source.owner_state?.resolver;
  const schedulerBackoff = source.schedule?.scheduler_backoff;
  const when = formatWhen(lastSuccessfulSync(source), options.now, options.offset);
  const withWhen = (prefix: string) => when ? `${prefix} · last synced ${when}` : prefix;

  if (resolver === "owner_paused") {
    const reattachAction = source.rendered_verdict?.required_actions.find((item) => item.kind === "reattach_schedule");
    const ownerPausedAction = source.source_kind === "local_device"
      ? action("view_device", "View this device", false)
      : reattachAction
        ? action("server_cta", reattachAction.cta, false)
        : null;
    return { row: 10, words: withWhen("Automatic sync is off"), tone: "faint", action: ownerPausedAction , sentence: { text: source.source_kind === "local_device" ? `Paused on ${source.local_device_progress?.device_name ?? "the computer that holds this data"}. Resume it there.` : source.status === "paused" ? `Paused. Your records${options.signInRepairAvailable ? " and sign-in" : ""} are kept.${when ? ` Last synced ${when}.` : ""}` : `Automatic sync is off.${when ? ` Last synced ${when}.` : ""}`, slot: null }, problem: false };
  }
  if (resolver === "blocked_maintainer") {
    if (onlyUnmeasuredCompleteness(source)) return { row: 13, words: `Synced${when ? ` ${when}` : ""}. DataConnect can't yet tell whether it got everything.`, tone: "plain", action: null , sentence: { text: `Synced${when ? ` ${when}` : ""}. DataConnect can't yet tell whether it got everything.`, slot: null }, problem: false };
    return { row: 13, words: "Waiting on a fix from the DataConnect maintainers", tone: "plain", action: null , sentence: { text: "This is waiting on a fix from the people who maintain DataConnect.", slot: null }, problem: true };
  }
  if (
    schedulerBackoff?.backoff_applied &&
    schedulerBackoff.recommended_health_state === "cooling_off"
  ) {
    return { row: 12, words: withWhen("Trying again on its own"), tone: "plain", action: null , sentence: { text: backoffSentence(source, options, name), slot: null }, problem: true };
  }
  if (source.last_run?.status === "failed") {
    const run = source.last_run;
    const cause = resolveSyncCause({ reason: run.failure_reason ?? run.terminal_reason, connector_error: run.connector_error }, (source.connector_display_name || formatConnectorKeyForDisplay(source.connector_id)).replace(BROWSER_SIGN_IN_SUFFIX, ""));
    return { row: 16, words: cause.sentence, tone: cause.action === "Sign in again" ? "attention" : "plain", action: cause.action && canStartSync(source) ? action(cause.action === "Sign in again" ? "repair_sign_in" : "sync_now", cause.action, true) : null , sentence: { text: cause.sentence, slot: null }, problem: true };
  }
  if (resolver === "system_degraded") {
    const label = source.rendered_verdict?.pill.label;
    const base = label === "Missing optional data"
      ? "Some optional data is missing"
      : label === "Some records stuck"
        ? "Some records are stuck"
        : `Something stopped ${(source.connector_display_name || formatConnectorKeyForDisplay(source.connector_id)).replace(BROWSER_SIGN_IN_SUFFIX, "")} from syncing.`;
    return { row: label === "Missing optional data" ? 14 : label === "Some records stuck" ? 15 : 16, words: base.startsWith("Something stopped") ? base : withWhen(base), tone: "plain", action: label !== "Missing optional data" && label !== "Some records stuck" && canStartSync(source) ? action("sync_now", "Try again", true) : null , sentence: { text: base.startsWith("Something stopped") ? base : `${base}.${when ? ` Last synced ${when}.` : ""}`, slot: null }, problem: true };
  }
  if (resolver === "refresh_due") {
    return { row: 17, words: withWhen("A refresh is due"), tone: "plain", action: syncAction(source) , sentence: { text: `A refresh is due.${when ? ` Last synced ${when}.` : ""}`, slot: null }, problem: false };
  }
  if (source.collection_report?.some(entry => ["retryable_gap","terminal_gap","gaps","partial"].includes(entry.coverage_condition))) {
    const text = "Some records didn't come at the last sync.";
    return {row:16,words:text,tone:"plain",action:null,sentence:{text,slot:null},problem:true};
  }
  if (resolver === "healthy") {
    if (options.pendingDetails || source.connection_health.detail_gap_backlog?.pending || source.collection_report?.some(entry=>entry.pending_detail_gaps>0)) {
      const text=`Synced${when ? ` ${when}` : ""}. Still checking a few things.`;
      return {row:20,words:text,tone:"plain",action:null,sentence:{text,slot:null},problem:false};
    }
    if (source.rendered_verdict?.pill.label === "Import complete") {
      return { row: 18, words: when ? `Imported ${when}` : "Imported", tone: "plain", action: null , sentence: { text: `${when ? `Imported ${when}` : "Imported"}. This was a one-time import; it does not sync on its own.`, slot: null }, problem: false };
    }
    // "Up to date" needs all four facts. A healthy answer alone does not prove
    // the data is current: a source that is late on its schedule is also healthy.
    if (
      source.rendered_verdict?.pill.label === "Healthy" &&
      source.owner_state?.posture === "observed" &&
      source.connection_health.lateness?.state === "on_time"
    ) {
      return { row: 19, words: when ? `Up to date · synced ${when}` : "Up to date", tone: "plain", action: null , sentence: { text: `Up to date.${when ? ` Synced ${when}.` : ""}`, slot: null }, problem: false };
    }
    return { row: 20, words: when ? `Synced ${when}` : "Synced", tone: "plain", action: null , sentence: { text: source.local_device_progress?.records_pending === 0 && source.owner_state?.resolver === "needs_owner" ? "No records are waiting to be sent." : `Synced${when ? ` ${when}` : ""}.${source.connection_health.lateness?.state === "late" || source.connection_health.lateness?.state === "overdue" ? " The next sync is late." : ""}${source.owner_state?.posture === "frozen-since-last-run" ? ` DataConnect has not compared this with ${name} yet.` : ""}`, slot: null }, problem: false };
  }
  if (resolver === "not_measured") {
    if (lastSuccessfulSync(source)) return { row: 21, words: when ? `Synced ${when}` : "Synced", tone: "plain", action: null , sentence: { text: `Synced${when ? ` ${when}` : ""}. DataConnect has not compared this with ${name} yet.`, slot: null }, problem: false };
    return { row: 22, words: source.source_kind === "manual" ? "Nothing imported yet" : "Not synced yet", tone: "plain", action: syncAction(source) , sentence: { text: source.source_kind === "manual" && !lastSuccessfulSync(source) ? "Nothing imported yet. Add an export to copy your records." : `${(source.source_kind === "manual" ? "Nothing imported yet" : "Not synced yet") .replace(FINAL_STOP, "")}.`, slot: null }, problem: false };
  }

  const fallback = fallbackPillRow(source, options);
  if (fallback) {
    if (!source.owner_state && fallback.row !== 23) return { ...fallback, row: 23 };
    return fallback;
  }
  if (!source.owner_state && (source.status || source.source_visibility)) {
    return { row: 23, words: "Status not available", tone: "faint", action: null , sentence: { text: source.source_kind === "manual" && !lastSuccessfulSync(source) ? "Nothing imported yet. Add an export to copy your records." : `${("Status not available") .replace(FINAL_STOP, "")}.`, slot: null }, problem: false };
  }
  return { row: 24, words: "Status not available", tone: "faint", action: null , sentence: { text: "Status not available.", slot: null }, problem: false };
}

export function sourceAnswer(source: RefConnectorSummary, options: SourceStatusOptions): SourceAnswer {
  const matched = matchSourceStatus(source, options);
  return { ...matched, needsYou: matched.action !== null };
}
export function sourceStatusWords(source: RefConnectorSummary, options: SourceStatusOptions): SourceStatusWords {
  const {sentence: _sentence, problem: _problem, ...status} = sourceAnswer(source, options);
  return status;
}
export function isUpToDateRow(row: SourceStatusRow): boolean { return row === 18 || row === 19; }
function backoffSentence(source: RefConnectorSummary, options: SourceStatusOptions, name: string): string {
  const backoff = source.schedule?.scheduler_backoff;
  const coming = backoff?.next_run_at && Date.parse(backoff.next_run_at) > options.now.getTime()+45_000 ? ` ${formatRelative(new Date(backoff.next_run_at), options.now.getTime())}` : "";
  return backoff?.reason_class === "source_pressure" || backoff?.consecutive_failures === 0 ? `${name} asked DataConnect to slow down. It will try again on its own${coming}.` : `The last sync did not finish. DataConnect will try again on its own${coming}.`;
}
export interface SourceStateSentenceOptions extends SourceStatusOptions {
  name: string;
  deviceName?: string;
  unsentRecords?: number;
  pendingDetails?: boolean;
}
export function sourceStateSentence(source: RefConnectorSummary, options: SourceStateSentenceOptions): SourceStateSentence {
  const progress = source.local_device_progress;
  const enriched = options.deviceName || options.unsentRecords !== undefined ? {...source,local_device_progress:{last_heartbeat_at:null,last_heartbeat_status:null,last_ingest_at:null,source_count:0,...progress,device_name:progress?.device_name ?? options.deviceName,records_pending:progress?.records_pending ?? options.unsentRecords ?? null}} : source;
  const answer = sourceAnswer(enriched, options);
  return answer.sentence;
}
