// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import type { SpineEvent } from "../lib/ref-client.ts";
import { humanizeFieldLabel, traceRowLabel } from "@pdpp/display";
import type { TraceSummary } from "../lib/ref-client.ts";
import { traceKindLabel } from "./trace-kind-label.ts";

export interface TraceEntryTitle {
  /** "An app" / "A device", or null when the events do not say who acted. */
  actor: string | null;
  /** Plain label of the first event's kind ("Data read", "App connection", …). */
  kind: string;
  title: string;
}

export function traceAppName(trace: TraceSummary | null): string {
  if (!trace) return "An app";
  if (trace.client?.client_name) {
    return trace.client.client_name;
  }
  const label = traceRowLabel(trace);
  return label.startsWith("client ") || label.startsWith("provider ") ? "App" : label;
}

/**
 * Plain title for one Activity entry, from the first event of its timeline.
 *
 * The timeline carries no app display name, so the actor is a generic word.
 * A read made with an app's access is an app's read even when the server
 * records the acting party as the owner (`actor_type: "subject"`), so a
 * `client_id` on the event also counts as "An app". When nothing says who
 * acted, the title names only what happened instead of inventing an actor.
 */
export function traceEntryTitle(
  first: Pick<SpineEvent, "actor_type" | "client_id" | "event_type"> | null,
  readFacts?: string | null,
  clientName?: string | null
): TraceEntryTitle {
  const kind = first ? traceKindLabel([first.event_type]) : "Activity";
  let actor: string | null = null;
  if (first?.actor_type === "device") {
    actor = "A device";
  } else if (first?.actor_type === "client" || first?.client_id) {
    actor = clientName || "An app";
  }
  if (kind === "Data read") {
    if (readFacts) {
      return { actor, kind, title: actor ? `${actor} read ${readFacts}` : `Read ${readFacts}` };
    }
    return { actor, kind, title: actor ? `${actor} read your data` : "Your data was read" };
  }
  return { actor, kind, title: actor ? `${actor}: ${kind.toLowerCase()}` : kind };
}

/**
 * A plain summary of what records an entry served, using only event facts.
 *
 * Only `disclosure.served` events that carry a `record_count` served records;
 * the others (schema, kind lists, kind descriptions, aggregates) served no
 * records, so they never name a kind as read. The summary speaks for the
 * whole entry, so it needs every event (`complete`) and exactly one event
 * that served records; otherwise it returns null and the caller says less.
 */
export function traceEntryReadFacts(events: readonly SpineEvent[], complete: boolean): string | null {
  if (!complete) {
    return null;
  }
  const served = events.filter(
    (item) =>
      item.event_type === "disclosure.served" &&
      typeof item.data.record_count === "number" &&
      Number.isFinite(item.data.record_count) &&
      item.data.record_count >= 0
  );
  const [event] = served;
  if (!event || served.length !== 1) {
    return null;
  }

  const count = event.data.record_count as number;
  const sourceValue = event.data.source;
  const sourceId =
    sourceValue && typeof sourceValue === "object" && !Array.isArray(sourceValue) &&
    typeof (sourceValue as { id?: unknown }).id === "string"
      ? (sourceValue as { id: string }).id
      : null;
  const source = sourceId ? humanizeFieldLabel(sourceId) : null;
  const streamLabel = typeof event.stream_id === "string" && event.stream_id ? humanizeFieldLabel(event.stream_id) : null;
  const stream = streamLabel ? `${streamLabel.charAt(0).toLowerCase()}${streamLabel.slice(1)}` : null;

  if (count === 1 && source && stream) {
    return `1 record of ${source} ${stream}`;
  }
  if (count === 1 && stream) {
    return `1 record of ${stream}`;
  }
  if (count === 1 && source) {
    return `1 record from ${source}`;
  }

  if (!(source || stream)) {
    return `${count.toLocaleString()} ${count === 1 ? "record" : "records"}`;
  }
  return [count.toLocaleString(), source, stream ?? "records"].filter(Boolean).join(" ");
}
