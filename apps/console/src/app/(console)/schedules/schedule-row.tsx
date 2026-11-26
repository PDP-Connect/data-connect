"use client";

// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { IcButton, IcTimestamp } from "@pdpp/brand-react";
import { formatConnectorKeyForDisplay } from "@pdpp/display";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useState, useTransition } from "react";
import { ConnectorMark } from "../components/connector-mark.tsx";
import { SourceStatusText } from "../components/source-status-text.tsx";
import { connectionDisplayName } from "../lib/connection-display-name.ts";
import type { RefConnectorSummary, RefSchedule } from "../lib/ref-client.ts";
import { sourceStatusWords } from "../lib/source-status-words.ts";
import { activeScheduleRunId, scheduleEnabled, scheduleIntervalSeconds } from "../lib/schedule-evidence.ts";
import { formatTotalRecordsLabel } from "../lib/total-records-label.ts";
import { pausedScheduleReason, scheduleChoices, scheduleSentence } from "./schedule-presentation.ts";
import { formatIntervalWords } from "./schedule-cadence-words.ts";
import { deleteScheduleAction, pauseScheduleAction, resumeScheduleAction, upsertScheduleAction } from "./actions.ts";

interface ScheduleRowProps {
  connectorIcon?: import("@pdpp/brand-react").ConnectorIconLike | null;
  runsHref: string;
  summary: RefConnectorSummary;
  deviceName?: string;
  presentation?: "plain" | "technical";
  practice?: boolean;
}

type EditState = "idle" | "editing";

function formatInterval(seconds: number | null): string {
  if (seconds === null) {
    return "—";
  }
  if (seconds < 60) {
    return `${seconds}s`;
  }
  if (seconds < 3600) {
    return `${Math.round(seconds / 60)}m`;
  }
  if (seconds < 86_400) {
    return `${Math.round(seconds / 3600)}h`;
  }
  return `${Math.round(seconds / 86_400)}d`;
}

function formatIntervalForInput(seconds: number | null): string {
  if (seconds === null) {
    return "";
  }
  if (seconds < 60) {
    return `${seconds}s`;
  }
  if (seconds % 3600 === 0) {
    return `${seconds / 3600}h`;
  }
  if (seconds % 60 === 0) {
    return `${seconds / 60}m`;
  }
  return `${seconds}s`;
}

function recommendedIntervalLabel(policy: RefConnectorSummary["refresh_policy"]): string | null {
  const seconds = scheduleIntervalSeconds(policy?.recommended_interval_seconds);
  if (seconds === null) {
    return null;
  }
  return formatInterval(seconds);
}

/**
 * Records routing keys on `connection_id` / `connector_instance_id` when the
 * schedule belongs to a specific instance; bare `connector_id` is only a
 * legacy fallback used while a single-instance row still exists.
 */
function recordsHrefForSummary(summary: RefConnectorSummary): string {
  // connection_id is non-optional in the current RefConnectorSummary contract,
  // but connector_instance_id/connector_id are a real legacy-server fallback
  // (single-instance rows predating connection_id).
  const routeId = summary.connection_id ?? summary.connector_instance_id ?? summary.connector_id;
  return `/sources/${encodeURIComponent(routeId)}`;
}

function modeLabel(mode: RefSchedule["effective_mode"]): string {
  if (mode === "automatic") {
    return "automatic";
  }
  if (mode === "paused") {
    return "paused";
  }
  return "manual";
}

function automationModeLabel(mode: RefSchedule["automation_mode"]): string {
  if (mode === "unattended") {
    return "unattended";
  }
  if (mode === "assisted") {
    return "assisted";
  }
  if (mode === "ask_before_run") {
    return "ask before run";
  }
  return "manual only";
}

function remoteScheduleFor(summary: RefConnectorSummary): RefSchedule | null {
  return summary.source_kind === "local_device" ? null : summary.schedule;
}

function ScheduleEditButton({
  intervalSeconds,
  isPending,
  jitterSeconds,
  onEdit,
}: {
  intervalSeconds: number | null;
  isPending: boolean;
  jitterSeconds: number | null;
  onEdit: (every: string, jitter: string) => void;
}) {
  return (
    <IcButton
      className="min-h-11"
      disabled={isPending || intervalSeconds === null}
      onClick={() => onEdit(formatIntervalForInput(intervalSeconds), formatIntervalForInput(jitterSeconds))}
      size="sm"
      variant="ghost"
    >
      Edit
    </IcButton>
  );
}

export function ScheduleRow({ connectorIcon, summary, runsHref, deviceName, presentation = "technical", practice = false }: ScheduleRowProps) {
  const router = useRouter();
  const [observedAt] = useState(() => Date.now());
  const [isPending, startTransition] = useTransition();
  const [editState, setEditState] = useState<EditState>("idle");
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const initialIntervalSeconds = scheduleIntervalSeconds(summary.schedule?.interval_seconds);
  const initialJitterSeconds = scheduleIntervalSeconds(summary.schedule?.jitter_seconds);
  const [every, setEvery] = useState(() => formatIntervalForInput(initialIntervalSeconds));
  const [jitter, setJitter] = useState(() => formatIntervalForInput(initialJitterSeconds));
  const [toast, setToast] = useState<{ kind: "error" | "warning"; message: string } | null>(null);

  const showToast = useCallback((kind: "error" | "warning", message: string) => {
    setToast({ kind, message });
    setTimeout(() => setToast(null), 8000);
  }, []);

  const handleSave = useCallback((choice?: string) => {
    startTransition(async () => {
      const res = await upsertScheduleAction(summary.connector_id, {
        // connection_id is non-optional in the current contract; connector_instance_id
        // is a real legacy-server fallback (see recordsHrefForSummary above).
        connectionId: summary.connection_id ?? summary.connector_instance_id ?? null,
        enabled: true,
        every: choice ?? every,
        jitter: jitter || undefined,
      });
      if (!res.ok) {
        showToast("error", res.message);
        return;
      }
      if (res.policy_warning) {
        showToast("warning", res.policy_warning);
      }
      setEditState("idle");
      router.refresh();
    });
  }, [summary.connection_id, summary.connector_id, summary.connector_instance_id, every, jitter, router, showToast]);

  const handlePause = useCallback(() => {
    startTransition(async () => {
      const res = await pauseScheduleAction(
        summary.connector_id,
        // connection_id is non-optional in the current contract; connector_instance_id
        // is a real legacy-server fallback (see recordsHrefForSummary above).
        summary.connection_id ?? summary.connector_instance_id ?? null
      );
      if (!res.ok) {
        showToast("error", res.message);
      }
      router.refresh();
    });
  }, [summary.connection_id, summary.connector_id, summary.connector_instance_id, router, showToast]);

  const handleResume = useCallback(() => {
    startTransition(async () => {
      const res = await resumeScheduleAction(
        summary.connector_id,
        // connection_id is non-optional in the current contract; connector_instance_id
        // is a real legacy-server fallback (see recordsHrefForSummary above).
        summary.connection_id ?? summary.connector_instance_id ?? null
      );
      if (!res.ok) {
        showToast("error", res.message);
      }
      router.refresh();
    });
  }, [summary.connection_id, summary.connector_id, summary.connector_instance_id, router, showToast]);

  const handleDelete = useCallback(() => {
    startTransition(async () => {
      const res = await deleteScheduleAction(
        summary.connector_id,
        // connection_id is non-optional in the current contract; connector_instance_id
        // is a real legacy-server fallback (see recordsHrefForSummary above).
        summary.connection_id ?? summary.connector_instance_id ?? null
      );
      if (!res.ok) {
        showToast("error", res.message);
      }
      router.refresh();
    });
  }, [summary.connection_id, summary.connector_id, summary.connector_instance_id, router, showToast]);

  const localDevice = summary.source_kind === "local_device";
  // A local-device source is not schedulable from the console. Treat any
  // legacy row as non-actionable so controls cannot reappear during cleanup.
  const schedule = remoteScheduleFor(summary);
  const showScheduleSetup = !localDevice && schedule === null;
  const policy = summary.refresh_policy;
  const displayName = connectionDisplayName(summary.display_name, summary.connector_display_name, summary.connector_id);
  const connectorKey = formatConnectorKeyForDisplay(summary.connector_id);
  const recordsHref = recordsHrefForSummary(summary);
  const activeRunId = activeScheduleRunId(schedule);
  const enabled = scheduleEnabled(schedule?.enabled);
  const intervalSeconds = scheduleIntervalSeconds(schedule?.interval_seconds);
  const jitterSeconds = scheduleIntervalSeconds(schedule?.jitter_seconds);
  // schedule is RefSchedule | null (remoteScheduleFor can return null); tsc
  // confirms schedule.human_attention_needed errors without the guard when
  // the fallback is removed. Biome's type-aware pass mis-resolves this one.
  const needsHuman = schedule?.human_attention_needed ?? false;
  const recInterval = recommendedIntervalLabel(policy);
  const recMode = policy?.recommended_mode;
  const rationale = policy?.rationale;
  // Stale unsafe schedule: row persists as operator intent (`enabled=true`),
  // but the connector's current manifest policy makes automatic refresh
  // ineligible, so the scheduler skips it. Surface the reason instead of
  // implying the row is running.
  const ineligibilityReason = schedule?.ineligibility_reason ?? null;
  const sourceStatus = sourceStatusWords(summary, { now: new Date() });
  const frequency = localDevice
    ? "On this device"
    : schedule
      ? formatIntervalWords(schedule.interval_seconds)
      : "Manual";
  let nextSync: string | null = null;
  if (localDevice) {
    nextSync = "Next sync not known";
  } else if (schedule?.enabled && schedule.ineligibility_reason) {
    nextSync = "Next sync not scheduled";
  } else if (schedule?.enabled) {
    nextSync = "Next sync not known";
  } else if (schedule) {
    nextSync = "Next sync paused";
  }

  if (presentation === "plain") return (
    <li className="border-border/70 border-b py-3 last:border-b-0">
      <div className="grid gap-2 sm:grid-cols-[1fr_auto]">
        <div className="grid gap-1">
          <Link className="text-foreground hover:underline" href={recordsHref}>{displayName}</Link>
          <p className="text-sm text-muted-foreground">{scheduleSentence(summary, observedAt, deviceName)}</p>
          {pausedScheduleReason(summary) ? <p className="text-sm text-muted-foreground">{pausedScheduleReason(summary)}</p> : null}
        </div>
        {!localDevice ? <div className="flex gap-2">
          <IcButton disabled={isPending} onClick={() => setEditState(editState === "editing" ? "idle" : "editing")} size="sm" variant="ghost">Change</IcButton>
          {schedule ? <IcButton disabled={isPending || practice} onClick={enabled ? handlePause : handleResume} size="sm" variant="ghost">{enabled ? "Pause" : "Resume"}</IcButton> : null}
        </div> : null}
      </div>
      {editState === "editing" ? <div className="grid justify-items-start gap-1 py-3" aria-label="How often to sync">
        {scheduleChoices(summary).map((choice) => <IcButton key={choice.seconds ?? "manual"} disabled={isPending || practice} aria-pressed={choice.seconds === (schedule?.interval_seconds ?? null)} variant="ghost" size="sm" onClick={() => choice.seconds === null ? setConfirmingDelete(true) : handleSave(`${choice.seconds}s`)}>{choice.label}{choice.seconds === null && !schedule ? " (now)" : ""}</IcButton>)}
        <IcButton variant="ghost" size="sm" onClick={() => setEditState("idle")}>Cancel</IcButton>
      </div> : null}
      {confirmingDelete ? <div role="alertdialog" aria-label="Stop automatic syncs" className="grid gap-2 py-3">
        <p>Automatic syncs will stop; your records will stay.</p>
        <div className="flex gap-2"><IcButton disabled={isPending || practice} onClick={handleDelete} size="sm">Stop automatic syncs</IcButton><IcButton variant="ghost" size="sm" onClick={() => setConfirmingDelete(false)}>Cancel</IcButton></div>
      </div> : null}
      {toast ? <div role="status"><p>This change could not be saved. Try again.</p><IcButton variant="ghost" size="sm" onClick={() => navigator.clipboard.writeText(toast.message)}>Copy details for support</IcButton></div> : null}
    </li>
  );

  return (
    <li className="border-border/70 border-b py-3 last:border-b-0" data-source-id={summary.connection_id} data-status-row={sourceStatus.row}>
      <div className="flex flex-col gap-2">
        {/* Top area: identity on its own line, then actions on a separate row on mobile */}
        {/* P0-1: at ≤640px these two sections stack vertically (flex-col) so
            the long source/account name never shares a line with the action buttons. */}
        <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
          {/* Identity */}
          <div className="min-w-0 flex-1">
            {/* The row title is the row's primary navigation link but stays
                text-tight visually (it sits directly above the mono connector
                key, not in a padded button row); the hit area grows to the
                44px floor via an invisible inset ::before, same technique as
                .rr-s-link / .rr-x-facet-not. */}
            <Link
              className="pdpp-body relative min-h-11 font-medium text-foreground before:absolute before:-inset-3 before:content-[''] hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              href={recordsHref}
            >
              <ConnectorMark spacing="after" connectorId={connectorKey} icon={connectorIcon} name={displayName} />
              {displayName}
            </Link>
            <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-[13px]">
              <SourceStatusText status={sourceStatus} />
              <span className="text-muted-foreground">{frequency}</span>
              <span className="text-muted-foreground">
                {schedule?.enabled && schedule.next_due_at ? (
                  <>Next sync <IcTimestamp mode="relative" value={schedule.next_due_at} /></>
                ) : nextSync}
              </span>
            </div>
          </div>

          {/* Status + action buttons — full-width row on mobile, right-pinned on sm+ */}
          <div className="flex shrink-0 flex-wrap items-center gap-2">
            {schedule && enabled !== null && (
              <>
                {enabled ? (
                  <IcButton className="min-h-11" disabled={isPending} onClick={handlePause} size="sm" variant="ghost">
                    Pause
                  </IcButton>
                ) : (
                  <IcButton className="min-h-11" disabled={isPending} onClick={handleResume} size="sm" variant="ghost">
                    Resume
                  </IcButton>
                )}
                <ScheduleEditButton
                  intervalSeconds={intervalSeconds}
                  isPending={isPending}
                  jitterSeconds={jitterSeconds}
                  onEdit={(nextEvery, nextJitter) => {
                    setEvery(nextEvery);
                    setJitter(nextJitter);
                    setEditState(editState === "editing" ? "idle" : "editing");
                  }}
                />
              </>
            )}
            {showScheduleSetup && (
              <IcButton className="min-h-11" disabled={isPending} onClick={() => setEditState("editing")} size="sm" variant="ghost">
                Set schedule
              </IcButton>
            )}
          </div>
        </div>

        {editState === "editing" && (
          <ScheduleEditor
            every={every}
            isPending={isPending}
            jitter={jitter}
            onCancel={() => setEditState("idle")}
            onEveryChange={setEvery}
            onJitterChange={setJitter}
            onSave={() => handleSave()}
            policy={policy}
            rationale={rationale}
            recInterval={recInterval}
          />
        )}

        {toast && (
          <p
            aria-live="polite"
            className={toast.kind === "error" ? "pdpp-caption text-destructive" : "pdpp-caption text-attention"}
            role="status"
          >
            {toast.message}
          </p>
        )}

        <details className="text-[13px] text-muted-foreground">
        <summary className="min-h-11 cursor-pointer py-2">Details</summary>
        <div className="grid gap-2 pb-2">
        <p className="font-mono">{connectorKey}</p>
        {activeRunId ? (
          <Link className="text-primary underline" href={`${runsHref}/${encodeURIComponent(activeRunId)}`}>Active sync →</Link>
        ) : null}
        {needsHuman ? <p>Needs human input</p> : null}
        {/* Stats row */}
        <div className="pdpp-caption flex flex-wrap gap-x-4 gap-y-1 text-muted-foreground">
          {schedule ? (
            <>
              <span>
                Mode: <span className="text-foreground">{modeLabel(schedule.effective_mode)}</span>
              </span>
              <span title={schedule.automation_summary}>
                Automation: <span className="text-foreground">{automationModeLabel(schedule.automation_mode)}</span>
              </span>
              <span>
                Every: <span className="text-foreground tabular-nums">{formatInterval(intervalSeconds)}</span>
              </span>
            </>
          ) : (
            <span>No schedule</span>
          )}
          {recMode && (
            <span>
              Recommended:{" "}
              <span className="text-foreground">
                {recMode}
                {recInterval ? ` · ${recInterval}` : ""}
              </span>
            </span>
          )}
          {summary.last_successful_run && (
            <span>
              Last success: <IcTimestamp value={summary.last_successful_run.last_at} />
            </span>
          )}
          {schedule?.last_started_at && !summary.last_successful_run && (
            <span>
              Last attempt: <IcTimestamp value={schedule.last_started_at} />
            </span>
          )}
          {/* Sol fourth-verdict P1.3: schedules is another direct
              RefConnectorSummary.total_records renderer — must route
              through the same centralized state-aware label. */}
          <span>{formatTotalRecordsLabel(summary.total_records, summary.total_records_state, "records")}</span>
        </div>

        {/* Ineligibility reason: stale enabled row + manifest policy changed */}
        {ineligibilityReason && (
          <p className="pdpp-caption text-attention">
            <strong>Manual runs only.</strong> {ineligibilityReason} You can still sync this data source by hand; pause or
            delete the schedule to match.
          </p>
        )}

        {/* Recommended rationale */}
        {rationale && <p className="pdpp-caption text-muted-foreground italic">{rationale}</p>}

        {/* Minimum-interval warning from last save */}
        {schedule?.minimum_interval_warning && (
          <p className="pdpp-caption text-attention">{schedule.minimum_interval_warning}</p>
        )}

        {schedule ? (
          <div className="grid gap-2">
            <IcButton className="min-h-11 text-destructive" disabled={isPending} onClick={() => setConfirmingDelete(true)} size="sm" variant="ghost" type="button">Delete</IcButton>
            {confirmingDelete ? (
              <div aria-labelledby={`delete-schedule-${summary.connection_id}`} className="grid gap-2 rounded-[6px] border border-border-strong p-3" role="alertdialog">
                <p id={`delete-schedule-${summary.connection_id}`}>Delete the schedule for {displayName}? Automatic syncs will stop; your records will stay.</p>
                <div className="flex flex-wrap gap-2">
                  <IcButton className="min-h-11" disabled={isPending} onClick={handleDelete} size="sm" type="button" variant="destructive">Delete schedule</IcButton>
                  <IcButton className="min-h-11" disabled={isPending} onClick={() => setConfirmingDelete(false)} size="sm" type="button" variant="ghost">Cancel</IcButton>
                </div>
              </div>
            ) : null}
          </div>
        ) : null}
        </div>
        </details>
      </div>
    </li>
  );
}

function frictionWarning(policy: RefConnectorSummary["refresh_policy"]): string | null {
  if (!policy) {
    return null;
  }
  if (policy.background_safe === false || (policy.interaction_posture && policy.interaction_posture !== "none")) {
    if (policy.interaction_posture === "otp_likely") {
      return "This data source often needs a one-time code or manual sign-in. Frequent automatic syncs may ask for it again.";
    }
    if (policy.interaction_posture === "manual_action_likely") {
      return "This data source often needs you to use a browser. Automatic syncs will pause until you finish.";
    }
    return "This data source needs sign-in details. A longer interval can reduce sign-in prompts.";
  }
  return null;
}

function ScheduleEditor({
  every,
  isPending,
  jitter,
  onCancel,
  onEveryChange,
  onJitterChange,
  onSave,
  policy,
  rationale,
  recInterval,
}: {
  every: string;
  isPending: boolean;
  jitter: string;
  onCancel: () => void;
  onEveryChange: (v: string) => void;
  onJitterChange: (v: string) => void;
  onSave: () => void;
  policy: RefConnectorSummary["refresh_policy"];
  rationale: string | null | undefined;
  recInterval: string | null;
}) {
  const warning = frictionWarning(policy);
  return (
    <div className="mt-1 flex flex-col gap-3 rounded-md border border-border/80 bg-muted/30 px-3 py-3">
      {warning && (
        <div className="pdpp-caption rounded-[6px] border border-border bg-muted px-3 py-2 text-attention">
          {warning}
          {rationale ? ` ${rationale}` : ""}
        </div>
      )}
      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1">
          <span className="pdpp-eyebrow text-muted-foreground">
            Every
            {policy?.recommended_interval_seconds ? ` (recommended: ${recInterval})` : ""}
          </span>
          <input
            className="pdpp-caption w-24 rounded border border-border bg-background px-2 py-1 focus:outline-none focus:ring-1 focus:ring-primary"
            onChange={(e) => onEveryChange(e.target.value)}
            placeholder="e.g. 30m"
            type="text"
            value={every}
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="pdpp-eyebrow text-muted-foreground">Jitter (optional)</span>
          <input
            className="pdpp-caption w-20 rounded border border-border bg-background px-2 py-1 focus:outline-none focus:ring-1 focus:ring-primary"
            onChange={(e) => onJitterChange(e.target.value)}
            placeholder="e.g. 5m"
            type="text"
            value={jitter}
          />
        </label>
        <div className="flex gap-2">
          <IcButton disabled={isPending} onClick={onSave} size="sm">
            Save
          </IcButton>
          <IcButton disabled={isPending} onClick={onCancel} size="sm" variant="ghost">
            Cancel
          </IcButton>
        </div>
      </div>
    </div>
  );
}
