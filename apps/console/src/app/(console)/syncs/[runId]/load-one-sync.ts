// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import { getRunStatus, getRunTimeline, listSyncHistory, getConnectionSetupStatus } from "../../lib/ref-client.ts";
import { getCurrentRunAssistance } from "../../lib/run-assistance.ts";
import { classifyKnownGaps, extractKnownGapsFromEventData } from "../../lib/run-gaps.ts";
import { readPersonOffset } from "../../history/server-day.ts";
import { historyRange } from "../../history/day-cut.ts";
import { loadHistorySources, sourceName } from "../../history/load-sources.ts";
import { historyKindName } from "../../history/source-names.ts";
import { practiceEnabled } from "../../history/practice.ts";
import { setupHref } from "../../connect/status/[connectionId]/connect-status-links.ts";
import { resolveRunConnectionId } from "./run-detail-labels.ts";
import { getCollectedKinds, getCollectionTerminalEvent } from "./collected-kinds.ts";
import { isRunHandleActive } from "./run-terminal-status.ts";
import { oneSyncPractice, recordKindName, type OneSyncModel } from "./one-sync-model.ts";
export async function loadOneSync(id: string, params: Record<string,string | undefined>): Promise<{ model: OneSyncModel | null; offset: number }> {
  const offset = await readPersonOffset();
  if (practiceEnabled(params.demo)) return { model: oneSyncPractice(params.demo as string), offset };
  const [status,timeline,history,sources] = await Promise.all([
    getRunStatus(id), getRunTimeline(id),
    listSyncHistory({ ...historyRange(offset), run_id: id, ...(params.connection_id ? { connection_id: params.connection_id } : {}) }),
    loadHistorySources(),
  ]);
  const persisted = history.mode === "syncs" ? history.data[0] : null;
  if (!status && !timeline && !persisted) return { model: null, offset };
  const events = timeline?.events ?? [];
  const connection = status?.connector_instance_id ?? persisted?.connection_id ?? resolveRunConnectionId(status, events);
  const connector = status?.connector_id ?? persisted?.connector_id ?? events.find(event => event.source?.connector_id)?.source?.connector_id ?? "";
  const active = status ? isRunHandleActive(status.status) : persisted ? persisted.outcome === "syncing" : !timeline?.terminal_status;
  const assistance = active ? getCurrentRunAssistance(events) : null;
  const outcome = assistance && assistance.ownerAction !== "none" ? "needs_you" : active ? "syncing" : persisted?.outcome ?? (status?.status === "completed" || timeline?.terminal_status === "completed" ? "finished" : status?.status === "cancelled" ? "stopped" : status?.status === "abandoned" ? "interrupted" : ["deferred","surface_failed"].includes(status?.status ?? "") ? "could_not_start" : "failed");
  const terminal = getCollectionTerminalEvent(events);
  const kinds = getCollectedKinds(terminal);
  const gaps = classifyKnownGaps(extractKnownGapsFromEventData({ known_gaps: status?.known_gaps ?? terminal?.data.known_gaps }).gaps).coverageGaps;
  const setup = connection && outcome === "failed" ? await getConnectionSetupStatus(connection).catch(() => null) : null;
  return { offset, model: { id, name: sourceName(sources,connection,connector), connector, connection,
    at: status?.started_at ?? persisted?.started_at ?? events[0]?.occurred_at ?? null,
    started: status?.started_at ?? persisted?.started_at ?? null, completed: status?.completed_at ?? persisted?.completed_at ?? null,
    outcome, cause: status?.failure?.reason ?? status?.terminal_reason ?? persisted?.cause ?? null,
    evidence: persisted?.evidence ?? {reason:status?.failure?.reason ?? status?.terminal_reason, error:status?.failure?.connector_error_message ?? status?.failure?.message},
    kindNames: Object.fromEntries((kinds ?? []).map(row=>[row.kind,historyKindName(sources,connection,row.kind)])),
    rawError: status?.failure?.connector_error_message ?? status?.failure?.message ?? null,
    trigger: persisted?.trigger ?? null, total: persisted?.records ?? (kinds ? kinds.reduce((n,k)=>n+k.count,0) : null), kinds,
    missing: persisted?.missing?.map(gap=>({name:historyKindName(sources,connection,gap.stream),canRetry:gap.retryable})) ?? gaps.filter(gap => gap.stream).map(gap => ({ name: historyKindName(sources,connection,gap.stream ?? null), canRetry: gap.recovery_hint?.retryable === true })), assistance,
    retryHref: setup ? setupHref(setup) : connection ? `/sources/${encodeURIComponent(connection)}` : null,
  } };
}
