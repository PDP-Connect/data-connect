// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Server-side silence detector for local-device collectors.
 *
 * A local collector is a one-shot process a host supervisor invokes on a timer:
 * it drains its outbox, posts a heartbeat, and exits. When it stops starting at
 * all — a bad install, an unreadable interpreter, an import that fails before
 * the first network call — the server records no failed run and no error,
 * because none was ever sent. The only observable is that `last_heartbeat_at`
 * stops advancing. A failure counter cannot see this: nothing fails.
 *
 * So silence is the detector. This stage runs on the connector-maintenance
 * sweep, and each tick opens an attention record for silent collectors that do
 * not have one yet.
 *
 * "That do not have one yet" is the query's job, not this file's, which is why
 * there is no cursor here, nothing persisted between ticks, and no wrap rule.
 * The query excludes any episode the owner has been told about or has acted on,
 * so every row it returns is unfinished work.
 *
 * A handled row usually leaves the next tick's results, but not always: a
 * notifier that fails before handing the push over records no outcome, so the
 * row stays selected to be retried. A bounded batch therefore does NOT on its
 * own guarantee progress — the query's ORDER BY is what does, by putting
 * never-recorded rows first and rotating the retry share by attempt age. That
 * reasoning lives with the ordering it describes, in the query's own header.
 *
 * Two tiers, one age authority. `HEARTBEAT_LEASE_MS` (30 minutes, from
 * heartbeat-lease.ts) already decides whether a heartbeat still describes the
 * collector's current state. This stage does not introduce a competing notion of
 * staleness; it asks a second, longer question of the same heartbeat age: not
 * "is this check-in still current" but "has this been quiet long enough that a
 * person should be told". Being wrong about the first greys out a badge; being
 * wrong about the second interrupts someone. Different costs, different
 * thresholds, one model.
 */

import type { AttentionRecord } from "../../runtime/attention.ts";
import { createAttention } from "../../runtime/attention.ts";
import { OWNER_AUTH_DEFAULT_SUBJECT_ID } from "../owner-auth.ts";
import { getDefaultConnectorAttentionStore } from "./connector-attention-store.ts";
import { makeDefaultAccountConnectorInstanceId } from "./connector-instance-store.ts";
import { getDefaultDeviceExporterStore, type SilentSourceInstance } from "./device-exporter-store.ts";

/**
 * How long a device source instance must be quiet before the product tells a
 * person about it. 24 hours is 96 heartbeat intervals at the 15-minute cadence
 * the documented systemd timer uses, which puts it clear of the transient causes
 * — a closed laptop, a suspended host, a weekend away — that a shorter tier
 * would report as an incident several times a week. A chosen threshold, not a
 * derived one: nothing proves no transient cause lasts a day, but a threshold
 * that cries wolf stops being read.
 */
export const DEVICE_SILENT_ESCALATION_MS = 24 * 60 * 60 * 1000;

/**
 * Instances handled per tick. A fleet-wide event — a bad release of the
 * collector package — could make every instance silent at once, and this keeps
 * one tick from monopolising a sweep it shares with four other phases. The
 * remainder genuinely does arrive on later ticks: handling a row writes the
 * record that removes it from the query, so the backlog shrinks tick by tick.
 */
const DEFAULT_MAX_INSTANCES_PER_TICK = 200;

/** Reason code carried on the attention record; stable, matched by consumers. */
export const DEVICE_SILENCE_REASON_CODE = "device_collector_silent";

export interface DeviceSilenceRoundResult {
  /** Unreported silent instances found this tick. */
  readonly detected: number;
  /** Records opened this tick. This is the edge a notifier may act on. */
  readonly opened: readonly OpenedDeviceSilence[];
}

export interface OpenedDeviceSilence {
  readonly attentionId: string;
  readonly connectionId: string;
  readonly connectorId: string;
}

export interface DeviceSilenceStage {
  run(args?: { readonly maxInstances?: number; readonly nowIso?: string }): Promise<DeviceSilenceRoundResult>;
}

/**
 * Attention id for one silence EPISODE: an instance plus the heartbeat that
 * preceded its silence.
 *
 * Stable within an episode, so re-detection upserts one row rather than
 * accumulating one per tick. Distinct across episodes, so an outage following a
 * recovery is a new record rather than a collision with a resolved one — silence
 * is a property of an interval, not of an instance, and the interval's start is
 * the last heartbeat before it.
 *
 * The silence query rebuilds this same string in SQL to exclude already-reported
 * instances, so the two must agree exactly; a test pins them against each other.
 */
export function deviceSilenceAttentionId(sourceInstanceId: string, lastHeartbeatAt: string): string {
  return `att_device_silence_${sourceInstanceId}_${lastHeartbeatAt.replace(/[^0-9A-Za-z]/g, "")}`;
}

function buildSilenceAttention(
  instance: SilentSourceInstance,
  { connectorInstanceId, now }: { connectorInstanceId: string | undefined; now: string }
): AttentionRecord {
  const connectionId =
    connectorInstanceId ?? makeDefaultAccountConnectorInstanceId(OWNER_AUTH_DEFAULT_SUBJECT_ID, instance.connectorId);
  return createAttention({
    auto_detect: true,
    connection_id: connectionId,
    dedupe_key: `${instance.connectorId}:${connectionId}:device:${DEVICE_SILENCE_REASON_CODE}:global`,
    id: deviceSilenceAttentionId(instance.sourceInstanceId, instance.lastHeartbeatAt ?? ""),
    metadata: {
      device_id: instance.deviceId,
      last_heartbeat_at: instance.lastHeartbeatAt,
      last_heartbeat_status: instance.lastHeartbeatStatus,
      records_pending: instance.recordsPending,
      source_instance_id: instance.sourceInstanceId,
    },
    now,
    // The owner has to go to the machine and restart the collector; there is
    // nothing to type into the console, so the action is elsewhere and no
    // structured response is expected.
    owner_action: "act_elsewhere",
    owner_copy:
      "This collector has not checked in for over a day. Data from it is not being collected, and anything it has already gathered is waiting on the device. Check that the collector is still running on that machine.",
    progress_posture: "blocked",
    reason_code: DEVICE_SILENCE_REASON_CODE,
    response_contract: "none",
    // Ids and timestamps only — not secret, but host-identifying.
    sensitivity: "non_secret",
  });
}

export function createDeviceSilenceStage(
  deps: {
    readonly attentionStore?: ReturnType<typeof getDefaultConnectorAttentionStore>;
    readonly deviceStore?: ReturnType<typeof getDefaultDeviceExporterStore>;
  } = {}
): DeviceSilenceStage {
  return {
    async run({ maxInstances, nowIso } = {}): Promise<DeviceSilenceRoundResult> {
      const now = nowIso ?? new Date().toISOString();
      const attentionStore = deps.attentionStore ?? getDefaultConnectorAttentionStore();
      const deviceStore = deps.deviceStore ?? getDefaultDeviceExporterStore();
      const cutoff = new Date(Date.parse(now) - DEVICE_SILENT_ESCALATION_MS).toISOString();

      const silent = await deviceStore.listSilentSourceInstances({
        limit: maxInstances ?? DEFAULT_MAX_INSTANCES_PER_TICK,
        silentBefore: cutoff,
      });

      const opened: OpenedDeviceSilence[] = [];
      for (const instance of silent) {
        // Nullable for rows written before the column existed. Pass `undefined`
        // so the store canonicalises it into the structured id the console reads
        // by; substituting the connector id would be non-empty and defeat that.
        const connectorInstanceId = instance.connectorInstanceId ?? undefined;
        const record = buildSilenceAttention(instance, { connectorInstanceId, now });

        // Conditional on the stored lifecycle, evaluated by the database in the
        // same statement that writes. The query already excludes episodes the
        // owner has acted on, but that decision is made when the page is read
        // and the write happens afterwards — an owner resolving a notice in
        // between would otherwise have it silently reopened and re-pushed. An
        // insert of a brand-new row is unaffected; only an update is guarded.
        const written = await attentionStore.upsertAttention({
          connectorId: instance.connectorId,
          ...(connectorInstanceId === undefined ? {} : { connectorInstanceId }),
          onlyIfLifecycleIn: ["open"],
          record,
        });

        // The store returns what is actually stored, so a refused write is
        // visible here rather than assumed away. Nothing is reported for it:
        // the owner has already dealt with this notice.
        if (written.lifecycle !== "open") {
          continue;
        }

        opened.push({
          attentionId: record.id,
          connectionId: record.connection_id,
          connectorId: instance.connectorId,
        });
      }

      return { detected: silent.length, opened };
    },
  };
}
