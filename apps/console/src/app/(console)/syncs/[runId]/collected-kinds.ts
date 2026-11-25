// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import type { SpineEvent } from "../../lib/ref-client.ts";

export function getCollectionTerminalEvent(events: SpineEvent[]): SpineEvent | null {
  return [...events].reverse().find((event) =>
    event.event_type === "run.completed" || event.event_type === "run.failed" || event.event_type === "run.cancelled"
  ) ?? null;
}

export function getCollectedKinds(terminalEvent: SpineEvent | null): { count: number; kind: string }[] | null {
  const facts = terminalEvent?.data.collection_facts;
  if (!facts || typeof facts !== "object" || Array.isArray(facts)) {
    return null;
  }
  const { streams } = facts as { streams?: unknown };
  // An empty list knows no counts, so it cannot say "Nothing was collected."
  if (!Array.isArray(streams) || streams.length === 0) {
    return null;
  }
  const collectedKinds: { count: number; kind: string }[] = [];
  for (const entry of streams) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      return null;
    }
    const { collected, stream } = entry as { collected?: unknown; stream?: unknown };
    if (typeof stream !== "string" || !stream.trim() || typeof collected !== "number" || !Number.isFinite(collected) || collected < 0) {
      return null;
    }
    collectedKinds.push({ count: collected, kind: stream.trim() });
  }
  return collectedKinds;
}
