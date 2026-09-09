// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Push notification for a local collector that has gone silent.
 *
 * The hard constraint here is that the sweep this hangs off is level-triggered:
 * it fires every 60 seconds and re-observes the same silent collector on every
 * tick for as long as the collector stays down. A push sent from the tick would
 * be 1,440 pushes a day, per device, indefinitely. So the tick is not the
 * trigger. The silence stage reports separately which attention records crossed
 * into open, and only that transition reaches this module.
 *
 * A transition alone is not enough in either direction, so the record's
 * `notification_state` field is both written and read here.
 *
 * Read, because the stage reports an open record with no recorded delivery as
 * an edge. That is deliberate: it is how a crash between opening the record and
 * sending the push is recovered, since without it that outage would be reported
 * to nobody, forever. But it means the same edge can be offered more than once,
 * so this checks the durable field immediately before dispatch and skips any
 * record already marked delivered.
 *
 * Written, because that check is only as good as the field. `upsertAttention`
 * overwrites the whole record body, and the notification state lives inside it,
 * so the stage carries the field forward explicitly on every re-write rather
 * than letting a freshly-constructed record reset it.
 *
 * Both halves have to be durable. The scheduler's existing dedupe lives in
 * in-memory sets that are lost on every deploy, which for a condition that can
 * affect the whole fleet at once would mean re-notifying everyone at restart.
 */

import { getDefaultConnectorAttentionStore } from "./stores/connector-attention-store.ts";
import type { DeviceSilenceRoundResult } from "./stores/device-silence-stage.ts";
import { NOTIFICATION_TIERS, projectNotificationDelivery } from "./notification-policy.ts";
import { fanoutEscalationWebPush, type WebPushConfig } from "./web-push-notifications.ts";

export interface DeviceSilencePushDeps {
  readonly attentionStore?: ReturnType<typeof getDefaultConnectorAttentionStore>;
  readonly config?: WebPushConfig;
  /**
   * Resolves owner-facing display text for a connector. Only the connector's
   * display name is ever used, and only in the notification title.
   */
  readonly connectorDisplayName: (connectorId: string) => Promise<string> | string;
  readonly log?: { warn?: (message: string) => void };
  readonly now?: () => Date;
  readonly ownerSubjectId: unknown;
  /** Structural mirror of notification-policy's own unexported quiet window. */
  readonly quietWindow?: Parameters<typeof projectNotificationDelivery>[0] extends infer Args
    ? Args extends { quietWindow?: infer Window }
      ? Window
      : never
    : never;
  readonly sendEscalationPush?: typeof fanoutEscalationWebPush;
  readonly store?: Parameters<typeof fanoutEscalationWebPush>[0]["store"];
}

/**
 * Notify the owner about collectors that just went silent.
 *
 * Returns the number of pushes actually dispatched, which is what the
 * exactly-once tests assert on.
 */
export async function notifyDeviceSilenceOpened(
  result: DeviceSilenceRoundResult,
  deps: DeviceSilencePushDeps
): Promise<number> {
  const attentionStore = deps.attentionStore ?? getDefaultConnectorAttentionStore();
  const sendEscalationPush = deps.sendEscalationPush ?? fanoutEscalationWebPush;
  const now = (deps.now ?? (() => new Date()))();
  let sent = 0;

  for (const opened of result.opened) {
    // Re-read the recorded outcome before sending. The query already excludes
    // episodes with one, so this is not the primary gate; it closes the window
    // where two callers act on the same round, or where a caller replays one.
    const current = await attentionStore.getAttentionById(opened.attentionId);
    if (current?.notification_updated_at) {
      continue;
    }

    // Classified INFORMATIONAL, not ACTION_REQUIRED. Quiet hours are only
    // applied to the informational tier by design, and a collector that has
    // been quiet for a day is not made worse by waiting until morning — the
    // data it would have collected is already not collected, and the backlog it
    // is holding is durable on the device. Waking someone at 3am buys nothing.
    const delivery = projectNotificationDelivery({
      channelOptedIn: true,
      now,
      ...(deps.quietWindow ? { quietWindow: deps.quietWindow } : {}),
      tier: NOTIFICATION_TIERS.INFORMATIONAL,
    });

    if (!delivery.interruptive_eligible) {
      // Stamped rather than skipped silently, so the record carries the reason
      // it was not pushed and a later tick does not treat the absence of a
      // stamp as "never attempted" and send during the quiet window after all.
      await stamp(attentionStore, opened.attentionId, "suppressed", "quiet_hours");
      continue;
    }

    // Inside the try, not before it. This lookup reads the connector summary
    // through the server's own projection path and can reject transiently. When
    // it sat outside, the rejection escaped to the sweep, which logs and
    // continues — leaving a record with no delivery and no recorded outcome,
    // which is indistinguishable from one nothing has tried yet. Keeping it here
    // means a failure takes the same path as a failed send: recorded, and
    // therefore retryable on the terms below rather than silently dropped.
    try {
      const connectorDisplayName = await deps.connectorDisplayName(opened.connectorId);
      const fanout = await sendEscalationPush({
        ...(deps.config ? { config: deps.config } : {}),
        connectionUrl: `/sources/${encodeURIComponent(opened.connectionId)}`,
        connectorDisplayName,
        ...(deps.log ? { log: deps.log as never } : {}),
        ownerSubjectId: deps.ownerSubjectId,
        // Reuses the existing closed reason enum rather than widening it. A
        // silent collector is precisely "the owner must do something before
        // collection resumes", which is what `needs_attention` already means to
        // both existing callers and to the service worker's dedupe tag. Adding
        // a third value would force an update at every consumer for a case the
        // existing vocabulary already describes.
        reason: "needs_attention",
        // The verdict gate is skipped deliberately. It exists to confirm a
        // connector-level rendered verdict is asking the owner for something,
        // and is projected from run evidence. This condition has no run — that
        // absence is the whole signal — so there is no verdict to consult, and
        // passing a synthesized one would assert something the projection never
        // computed. The attention record's own transition into open is the
        // authority here, and it is a stronger one.
        ...(deps.store ? { store: deps.store } : {}),
      });
      if (fanout.sent > 0) {
        sent += 1;
        await stamp(attentionStore, opened.attentionId, "sent", null);
      } else {
        // No subscription, or the channel is off. Recorded as failed so the
        // console can answer "did we tell them?" honestly; the attention record
        // itself stays open regardless, because the owner action is still
        // outstanding whether or not a push reached them.
        await stamp(attentionStore, opened.attentionId, "failed", "no_delivery");
      }
    } catch (err) {
      // Left unstamped on purpose, which is the one case that does not record an
      // outcome. Everything above this line — resolving the display name,
      // reaching the sender — happens before the push is handed over, so a
      // throw here means the owner was certainly not told and nothing is known
      // about a delivery that never began. Recording `failed` would be a lie of
      // the more dangerous kind: it reads as "we tried and it did not arrive",
      // and it would make the notice permanently ineligible for the retry the
      // stage offers on the next tick. The record therefore stays pending with
      // no timestamp, which is exactly what it is — untried — and the next tick
      // picks it up. A failure that repeats every tick is visible as a warning
      // per tick rather than as a silently dropped notice.
      const message = err instanceof Error ? err.message : String(err);
      deps.log?.warn?.(
        `[device-silence] push attempt failed before delivery for ${opened.attentionId}; will retry: ${message}`
      );
    }
  }

  return sent;
}

async function stamp(
  attentionStore: ReturnType<typeof getDefaultConnectorAttentionStore>,
  attentionId: string,
  outcome: string,
  reason: string | null
): Promise<void> {
  try {
    await attentionStore.recordNotificationOutcomeById({ attentionId, outcome, reason });
  } catch {
    // A failed stamp must not fail the sweep phase. The worst case is a repeat
    // push on a subsequent transition, which the open-record check still bounds.
  }
}
