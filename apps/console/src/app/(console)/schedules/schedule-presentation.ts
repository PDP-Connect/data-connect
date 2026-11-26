// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import type { RefConnectorSummary } from "../lib/ref-client.ts";
import { formatIntervalWords } from "./schedule-cadence-words.ts";

export function scheduleSentence(source: RefConnectorSummary, now = Date.now(), deviceName?: string): string {
  if (source.status === "paused" || source.owner_state?.resolver === "owner_paused") return "Paused";
  if (source.source_kind === "local_device") return `Syncs from ${deviceName || "its device"} when that computer runs it`;
  const schedule = source.schedule;
  if (!schedule) return "Only when you press Sync now";
  if (!schedule.enabled || schedule.effective_mode === "paused") return "Paused";
  if (schedule.ineligibility_reason) return "Only when you press Sync now";
  let sentence = formatIntervalWords(schedule.interval_seconds);
  if (schedule.next_due_at) {
    const hours = Math.round((Date.parse(schedule.next_due_at) - now) / 3_600_000);
    sentence += hours > 0 ? ` · next sync in about ${hours} ${hours === 1 ? "hour" : "hours"}` : " · next sync due soon";
  }
  return sentence;
}
export function scheduleChoices(source: RefConnectorSummary) {
  if (source.source_kind === "local_device") return [];
  const recommended = source.refresh_policy?.recommended_interval_seconds ?? 0;
  const current = source.schedule?.interval_seconds;
  const seconds = [...new Set([3600, 21_600, 86_400, 604_800, ...(current ? [current] : []), ...(recommended ? [recommended] : [])])]
    .filter((value) => value >= recommended || value === current).sort((a, b) => a - b);
  return [...seconds.map((value) => ({ seconds: value, label: `${formatIntervalWords(value)}${value === recommended ? " (recommended)" : value === current && ![3600, 21_600, 86_400, 604_800].includes(value) ? " (now)" : ""}` })), { seconds: null, label: "Only when I press Sync now" }];
}
export function buildSchedulePractice(state: string): RefConnectorSummary[] | null {
  if (state === "none") return [];
  if (!["mixed", "paused"].includes(state)) return null;
  return Array.from({ length: state === "paused" ? 32 : 6 }, (_, index) => {
    const interval = [86_400, 3600, 2700][index % 3]!;
    const paused = state === "paused" || index === 4;
    return {
      connection_id: `practice-${index}`, connector_id: "sample", connector_display_name: "Sample", display_name: ["Calendar", "Reading list", "Notes", "Recipes", "Bookmarks", "Work computer"][index % 6],
      source_kind: index === 5 && state === "mixed" ? "local_device" : "account",
      refresh_policy: { recommended_interval_seconds: index === 2 ? 21_600 : interval },
      schedule: index === 3 && state === "mixed" ? null : { enabled: !paused, effective_mode: paused ? "paused" : "automatic", interval_seconds: interval, jitter_seconds: 0, next_due_at: null },
      connection_health: { axes: { attention: "none", coverage: "complete", freshness: "fresh", outbox: "idle" }, badges: { stale: false, syncing: false }, last_success_at: null, lateness: { state: "on_time" }, next_action: null, next_attempt_at: null, reason_code: null, state: "healthy", unknown_reasons: [] }, manifest_version: null, next_action: null,
      streams: [], total_records: 0, freshness: {}, last_run: null, last_successful_run: null,
    } as unknown as RefConnectorSummary;
  });
}
