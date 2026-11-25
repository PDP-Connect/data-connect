// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import type { SpineEvent } from "../lib/ref-client.ts";
import { traceKindLabel } from "./trace-kind-label.ts";

export interface TraceEntryTitle {
  /** "An app" / "A device", or null when the events do not say who acted. */
  actor: string | null;
  /** Plain label of the first event's kind ("Data read", "App connection", …). */
  kind: string;
  title: string;
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
export function traceEntryTitle(first: Pick<SpineEvent, "actor_type" | "client_id" | "event_type"> | null): TraceEntryTitle {
  const kind = first ? traceKindLabel([first.event_type]) : "Activity";
  let actor: string | null = null;
  if (first?.actor_type === "device") {
    actor = "A device";
  } else if (first?.actor_type === "client" || first?.client_id) {
    actor = "An app";
  }
  if (kind === "Data read") {
    return { actor, kind, title: actor ? `${actor} read your data` : "Your data was read" };
  }
  return { actor, kind, title: actor ? `${actor}: ${kind.toLowerCase()}` : kind };
}
