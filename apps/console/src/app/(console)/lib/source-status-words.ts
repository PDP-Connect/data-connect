// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { formatRelative } from "@pdpp/display";
import type { RefConnectorSummary, RefRequiredAction } from "./ref-client.ts";
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
  /** True when the person must act before this data source can sync (rows 4, 5, 6, 8, 9). */
  needsYou: boolean;
}

type MatchedStatus = Omit<SourceStatusWords, "needsYou">;

const NEEDS_YOU_ROWS: ReadonlySet<SourceStatusRow> = new Set<SourceStatusRow>([4, 5, 6, 8, 9]);

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
  signInRepairAvailable?: boolean;
}

const DAY_MS = 24 * 60 * 60 * 1000;

function lastSuccessfulSync(source: RefConnectorSummary): string | null {
  return source.connection_health.last_success_at ?? source.last_successful_run?.last_at ?? null;
}

function formatWhen(value: string | null, now: Date): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;

  const age = now.getTime() - date.getTime();
  if (age < 0) return "just now";
  if (age < 7 * DAY_MS) return formatRelative(date, now.getTime());

  const sameYear = date.getUTCFullYear() === now.getUTCFullYear();
  return new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "short",
    ...(sameYear ? {} : { year: "numeric" }),
    // UTC is acceptable for this server-rendered page, which has no viewer-local timezone.
    timeZone: "UTC",
  }).format(date);
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

function lifecycleRow(
  source: RefConnectorSummary,
  projection: ReturnType<typeof projectSourceActionability>,
  signInRepairAvailable: boolean | undefined
): MatchedStatus | null {
  if (projection.renderedStatus.kind === "archived") return { row: 1, words: "Archived", tone: "faint", action: null };
  if (projection.renderedStatus.kind === "setup_failed") {
    return { row: 2, words: "Setup never completed", tone: "faint", action: action("continue_setup", "Continue setup", false) };
  }
  if (projection.revoked) return { row: 3, words: "Disconnected", tone: "faint", action: action("set_up_again", "Set up again", false) };
  if (source.connector_implementation?.state === "not_installed") {
    return { row: 4, words: "Needs to get ready again", tone: "attention", action: action("install", `Get ${source.connector_display_name ?? source.display_name} ready`, true) };
  }

  switch (source.terminal_setup_disposition) {
    case "unverified_missing_counts": {
      const serverAction = ownerAction(source);
      const renderableServerAction = serverAction && serverAction.satisfied_when.kind !== "none";
      const fallbackAction = source.source_kind === "local_device"
        ? syncAction(source)
        : source.status === "paused"
          ? action("resume", "Resume syncing", false)
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
      };
    }
    case "unverified_zero":
      return { row: 6, words: "First sync found no records", tone: "attention", action: action("retry_first_sync", "Retry first sync", true) };
    case "verified_empty":
      return { row: 7, words: "No records found", tone: "plain", action: action("review_result", "Review result", false) };
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
          ? action("resume", "Resume syncing", false)
          : action("repair_credential", "Continue", false)
        : action("resume", "Resume", false);
    return { row: 10, words: "Paused", tone: "faint", action: pausedAction };
  }
  if (resolver === "needs_owner") {
    const requiredAction = ownerAction(source);
    const surface = requiredAction?.surface?.kind;
    const words = surface === "browser_session"
      ? "Needs you to sign in again"
      : surface === "stored_credential"
        ? "Needs its saved sign-in details updated"
        : surface === "provider_interaction"
          ? "Waiting for you to finish a step"
          : surface === "local_device"
            ? "Needs attention on your device"
            : "Needs you";
    return {
      row: 8,
      words,
      tone: "attention",
      action: requiredAction ? action("server_cta", surface === "local_device" ? "See what to do on that computer" : surface === "stored_credential" ? "Update sign-in details" : requiredAction.cta, true) : null,
    };
  }
  if (resolver === "setup_in_progress") {
    return { row: 9, words: "Setup in progress", tone: "attention", action: action("continue_setup", "Continue setup", true) };
  }
  if (resolver === "collecting" || (!source.owner_state && projection.renderedStatus.kind === "pending")) {
    return { row: 11, words: "Syncing now", tone: "accent", action: null };
  }
  return null;
}

function fallbackPillRow(source: RefConnectorSummary, now: Date): MatchedStatus | null {
  const label = source.rendered_verdict?.pill.label;
  if (!label) return null;
  const when = formatWhen(lastSuccessfulSync(source), now);
  const withWhen = (prefix: string) => when ? `${prefix} · last synced ${when}` : prefix;
  if (label === "Missing optional data") return { row: 14, words: withWhen("Some optional data is missing"), tone: "plain", action: null };
  if (label === "Some records stuck") return { row: 15, words: withWhen("Some records are stuck"), tone: "plain", action: null };
  if (label === "Missing data" || label === "Can't collect") return { row: 16, words: withWhen("Trouble syncing"), tone: "plain", action: null };
  if (label === "Import complete") return { row: 18, words: when ? `Imported ${when}` : "Imported", tone: "plain", action: null };
  if (label === "Needs refresh") return { row: 17, words: withWhen("A refresh is due"), tone: "plain", action: syncAction(source) };
  if (label === "Not measured") {
    if (lastSuccessfulSync(source)) return { row: 21, words: when ? `Synced ${when}` : "Synced", tone: "plain", action: null };
    return { row: 23, words: source.source_kind === "manual" ? "Nothing imported yet" : "Not synced yet", tone: "plain", action: syncAction(source) };
  }
  if (label === "Healthy" || label === "Collected, not independently checked") {
    return { row: 20, words: when ? `Synced ${when}` : "Synced", tone: "plain", action: null };
  }
  return { row: 23, words: "Status not available", tone: "faint", action: null };
}

function matchSourceStatus(source: RefConnectorSummary, { now, signInRepairAvailable }: SourceStatusOptions): MatchedStatus {
  const projection = projectSourceActionability(source);
  const lifecycle = lifecycleRow(source, projection, signInRepairAvailable);
  if (lifecycle) return lifecycle;

  const resolver = source.owner_state?.resolver;
  const schedulerBackoff = source.schedule?.scheduler_backoff;
  const when = formatWhen(lastSuccessfulSync(source), now);
  const withWhen = (prefix: string) => when ? `${prefix} · last synced ${when}` : prefix;

  if (resolver === "owner_paused") {
    const reattachAction = source.rendered_verdict?.required_actions.find((item) => item.kind === "reattach_schedule");
    const ownerPausedAction = source.source_kind === "local_device"
      ? action("view_device", "View this device", false)
      : reattachAction
        ? action("server_cta", reattachAction.cta, false)
        : null;
    return { row: 10, words: withWhen("Automatic sync is off"), tone: "faint", action: ownerPausedAction };
  }
  if (resolver === "blocked_maintainer") {
    return { row: 13, words: "Waiting on a fix from the DataConnect maintainers", tone: "plain", action: null };
  }
  if (
    schedulerBackoff?.backoff_applied &&
    schedulerBackoff.recommended_health_state === "cooling_off"
  ) {
    return { row: 12, words: withWhen("Trying again on its own"), tone: "plain", action: null };
  }
  if (resolver === "system_degraded") {
    const label = source.rendered_verdict?.pill.label;
    const base = label === "Missing optional data"
      ? "Some optional data is missing"
      : label === "Some records stuck"
        ? "Some records are stuck"
        : "Trouble syncing";
    return { row: label === "Missing optional data" ? 14 : label === "Some records stuck" ? 15 : 16, words: withWhen(base), tone: "plain", action: null };
  }
  if (resolver === "refresh_due") {
    return { row: 17, words: withWhen("A refresh is due"), tone: "plain", action: syncAction(source) };
  }
  if (resolver === "healthy") {
    if (source.rendered_verdict?.pill.label === "Import complete") {
      return { row: 18, words: when ? `Imported ${when}` : "Imported", tone: "plain", action: null };
    }
    // "Up to date" needs all four facts. A healthy answer alone does not prove
    // the data is current: a source that is late on its schedule is also healthy.
    if (
      source.rendered_verdict?.pill.label === "Healthy" &&
      source.owner_state?.posture === "observed" &&
      source.connection_health.lateness?.state === "on_time"
    ) {
      return { row: 19, words: when ? `Up to date · synced ${when}` : "Up to date", tone: "plain", action: null };
    }
    return { row: 20, words: when ? `Synced ${when}` : "Synced", tone: "plain", action: null };
  }
  if (resolver === "not_measured") {
    if (lastSuccessfulSync(source)) return { row: 21, words: when ? `Synced ${when}` : "Synced", tone: "plain", action: null };
    return { row: 22, words: source.source_kind === "manual" ? "Nothing imported yet" : "Not synced yet", tone: "plain", action: syncAction(source) };
  }

  const fallback = fallbackPillRow(source, now);
  if (fallback) {
    if (!source.owner_state && fallback.row !== 23) return { ...fallback, row: 23 };
    return fallback;
  }
  if (!source.owner_state && (source.status || source.source_visibility)) {
    return { row: 23, words: "Status not available", tone: "faint", action: null };
  }
  return { row: 24, words: "Status not available", tone: "faint", action: null };
}

export function sourceStatusWords(source: RefConnectorSummary, options: SourceStatusOptions): SourceStatusWords {
  const matched = matchSourceStatus(source, options);
  return { ...matched, needsYou: NEEDS_YOU_ROWS.has(matched.row) };
}

export function isUpToDateRow(row: SourceStatusRow): boolean {
  return row === 18 || row === 19;
}

/** "in 20 minutes", "in 4 hours": a coming time without a clock time, so no time zone is assumed. */
function formatComing(value: string | null | undefined, now: Date): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime()) || date.getTime() <= now.getTime() + 45_000) return null;
  return formatRelative(date, now.getTime());
}

export interface SourceStateSentenceOptions extends SourceStatusOptions {
  name: string;
  deviceName?: string;
  unsentRecords?: number;
  pendingDetails?: boolean;
}

const PENDING_DETAILS_SENTENCE = "Still checking a few things.";

export function sourceStateSentence(source: RefConnectorSummary, options: SourceStateSentenceOptions): SourceStateSentence {
  const { text, slot = null } = matchStateSentence(source, options);
  // Rows 19-20 replace their sentence; every other row keeps it and adds the pending note.
  const pending = options.pendingDetails && !text.endsWith(PENDING_DETAILS_SENTENCE) ? ` ${PENDING_DETAILS_SENTENCE}` : "";
  return { text: `${text}${pending}`, slot };
}

function matchStateSentence(
  source: RefConnectorSummary,
  options: SourceStateSentenceOptions
): { text: string; slot?: SourceStateSentence["slot"] } {
  const status = matchSourceStatus(source, options);
  const when = formatWhen(lastSuccessfulSync(source), options.now);
  const withLastSync = (prefix: string) => when ? `${prefix} Last synced ${when}.` : `${prefix}.`;
  const wordsWithoutWhen = () => when ? status.words.replace(` · last synced ${when}`, "") : status.words;

  if (options.pendingDetails && (status.row === 19 || status.row === 20)) {
    return { text: `Synced${when ? ` ${when}` : ""}. ${PENDING_DETAILS_SENTENCE}` };
  }

  switch (status.row) {
    case 1: return { text: "Archived. It no longer syncs." };
    case 2: return { text: "Setup was never completed." };
    case 3: return { text: "Disconnected.", slot: "what_is_kept_and_what_set_up_again_does" };
    case 4: return { text: `DataConnect needs to get ${options.name} ready again.` };
    case 5: return { text: `The first copy of ${options.name} may not be complete.`, slot: "what_you_can_do" };
    case 6: return { text: "First sync found no records.", slot: "what_you_can_do" };
    case 7: return { text: "No records found.", slot: "what_you_can_do" };
    case 8: {
      const surface = ownerAction(source)?.surface?.kind;
      const sentence = surface === "browser_session"
        ? `${options.name} needs you to sign in again.`
        : surface === "stored_credential"
          ? `${options.name} needs its saved sign-in details updated.`
          : surface === "provider_interaction"
            ? `${options.name} is waiting for you to finish a step.`
            : surface === "local_device"
              ? `The computer that holds this data${options.deviceName ? ` (${options.deviceName})` : ""} could not send${typeof options.unsentRecords === "number" ? ` ${options.unsentRecords.toLocaleString()} records` : " some records"}.`
              : `${options.name} needs you.`;
      const extra = source.rendered_verdict?.pill.label === "Some records stuck"
        ? " Some records are stuck."
        : source.rendered_verdict?.pill.label === "Missing optional data"
          ? " Some optional data is missing."
          : "";
      return { text: `${sentence}${extra}${when ? ` Last successful sync ${when}.` : ""}` };
    }
    case 9: return { text: "Setup is in progress." };
    case 10:
      return source.status === "paused"
        ? {
            text: withLastSync(
              options.signInRepairAvailable
                ? "Paused. Your records and sign-in are kept."
                : "Paused. Your records are kept."
            ),
          }
        : { text: when ? `Automatic sync is off. Last synced ${when}.` : "Automatic sync is off." };
    case 11: {
      const started = source.last_run && ["pending", "started", "in_progress", "running"].includes(source.last_run.status)
        ? source.last_run.started_at
        : null;
      const startedWhen = formatWhen(started, options.now);
      return { text: startedWhen ? `Syncing now. Started ${startedWhen}.` : "Syncing now." };
    }
    case 12: {
      const backoff = source.schedule?.scheduler_backoff;
      const coming = formatComing(backoff?.next_run_at, options.now);
      if (backoff?.reason_class === "source_pressure" || backoff?.consecutive_failures === 0) {
        return { text: `${options.name} asked DataConnect to slow down. It will try again on its own${coming ? ` ${coming}` : ""}.` };
      }
      return { text: `The last sync did not finish. DataConnect will try again on its own${coming ? ` ${coming}` : ""}.` };
    }
    case 13: return { text: "This is waiting on a fix from the people who maintain DataConnect. There is nothing for you to do." };
    case 14:
    case 15:
    case 16: {
      const base = `${wordsWithoutWhen()}.`;
      const retry = source.schedule?.scheduler_backoff?.backoff_applied ? " DataConnect will keep trying." : "";
      return { text: `${base}${retry}${when ? ` Last synced ${when}.` : ""}` };
    }
    case 17: return { text: `A refresh is due.${when ? ` Last synced ${when}.` : ""}${source.schedule?.effective_mode === "manual" ? " This one syncs only when you ask." : ""}` };
    case 18: return { text: `${when ? `Imported ${when}` : "Imported"}. This was a one-time import; it does not sync on its own.` };
    case 19: {
      const coming = formatComing(source.schedule?.next_due_at, options.now);
      return { text: `Up to date.${when ? ` Synced ${when}${coming ? `; next ${coming}` : ""}.` : ""}` };
    }
    case 20: {
      const lateness = source.connection_health.lateness?.state;
      const late = lateness === "late" || lateness === "overdue" ? " The next sync is late." : "";
      const unchecked = source.owner_state?.posture === "frozen-since-last-run"
        ? " DataConnect has not checked this against the source."
        : "";
      return { text: `Synced${when ? ` ${when}` : ""}.${late}${unchecked}` };
    }
    case 21: return { text: `Synced${when ? ` ${when}` : ""}. DataConnect has not checked for missing records.` };
    case 22: return { text: `${status.words}.` };
    case 23: {
      const label = source.rendered_verdict?.pill.label;
      if (label === "Import complete") {
        return { text: `${when ? `Imported ${when}` : "Imported"}. This was a one-time import; it does not sync on its own.` };
      }
      if (label === "Needs refresh") {
        return { text: `A refresh is due.${when ? ` Last synced ${when}.` : ""}${source.schedule?.effective_mode === "manual" ? " This one syncs only when you ask." : ""}` };
      }
      if (label === "Not measured") return { text: lastSuccessfulSync(source) ? `Synced${when ? ` ${when}` : ""}. DataConnect has not checked for missing records.` : "Not synced yet." };
      if (label === "Collected, not independently checked") return { text: `Synced${when ? ` ${when}` : ""}. DataConnect has not checked this against the source.` };
      if (label === "Missing optional data" || label === "Some records stuck" || label === "Missing data" || label === "Can't collect") {
        const willRetry = source.schedule?.scheduler_backoff?.backoff_applied ? " DataConnect will keep trying." : "";
        return { text: `${wordsWithoutWhen()}.${willRetry}${when ? ` Last synced ${when}.` : ""}` };
      }
      return { text: `${status.words}.` };
    }
    case 24: return { text: "Status not available." };
  }
}
