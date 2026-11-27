// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { formatRelative } from "@pdpp/display";
import type { RefSchedule } from "./ref-client.ts";
import { scheduleEnabled, scheduleIntervalSeconds } from "./schedule-evidence.ts";

/**
 * The one answer to "is anything scheduled, and how often". The sources list, the source
 * page, the first-sync page and Sync history all read it, so a sentence cannot promise a
 * retry where another line says DataConnect checks only when asked.
 */
export type ScheduleFacts = Pick<RefSchedule, "effective_mode" | "enabled" | "interval_seconds">;

const SECONDS_PER_DAY = 86_400;
const SECONDS_PER_HOUR = 3600;
const SECONDS_PER_MINUTE = 60;

/** "Manual", "Every 6 hours", or "—" when the schedule cannot be read. */
export function formatSourceRowSchedule(schedule: ScheduleFacts | null): string {
  if (!schedule) return "Manual";
  const enabled = scheduleEnabled(schedule.enabled);
  if (schedule.effective_mode === "manual" || enabled === false) return "Manual";
  if (enabled !== true) return "—";

  const seconds = scheduleIntervalSeconds(schedule.interval_seconds);
  if (seconds === null) return "—";
  const units = [
    { label: "day", seconds: SECONDS_PER_DAY },
    { label: "hour", seconds: SECONDS_PER_HOUR },
    { label: "minute", seconds: SECONDS_PER_MINUTE },
  ];
  const unit = units.find((candidate) => seconds % candidate.seconds === 0);
  if (!unit) return "—";
  const count = seconds / unit.seconds;
  return `Every${count === 1 ? "" : ` ${count}`} ${unit.label}${count === 1 ? "" : "s"}`;
}

export type ScheduleState =
  | { kind: "unknown" }
  | { kind: "manual" }
  | { kind: "scheduled"; every: string };

/** `undefined` means the schedule was not read; `null` means the source has none. */
export function scheduleState(schedule: ScheduleFacts | null | undefined): ScheduleState {
  if (schedule === undefined) return { kind: "unknown" };
  const label = formatSourceRowSchedule(schedule);
  if (label === "Manual") return { kind: "manual" };
  if (/^Every\b/.test(label)) return { every: `${label.charAt(0).toLowerCase()}${label.slice(1)}`, kind: "scheduled" };
  return { kind: "unknown" };
}

export function isScheduled(schedule: ScheduleFacts | null | undefined): boolean {
  return scheduleState(schedule).kind === "scheduled";
}

/**
 * The honest Schedule line for a scheduled source whose last successful sync is long
 * past: more than two intervals ago and nothing running. Returns null otherwise, so the
 * plain promise ("DataConnect checks X every hour.") stays for a source that keeps up.
 */
export function overdueScheduleSentence(
  _name: string,
  schedule: Pick<RefSchedule, "active_run_id" | "effective_mode" | "enabled" | "interval_seconds" | "last_successful_at"> | null | undefined,
  now: Date,
): string | null {
  const state = scheduleState(schedule);
  if (state.kind !== "scheduled" || !schedule || schedule.active_run_id) return null;
  const seconds = scheduleIntervalSeconds(schedule.interval_seconds);
  const last = schedule.last_successful_at ? Date.parse(schedule.last_successful_at) : Number.NaN;
  if (seconds === null || Number.isNaN(last)) return null;
  if (now.getTime() - last <= seconds * 2000) return null;
  return `It should check ${state.every}, but the last successful sync was ${formatRelative(new Date(last), now.getTime())}.`;
}
