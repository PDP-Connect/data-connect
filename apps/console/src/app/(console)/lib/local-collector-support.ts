// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import type { OwnerConnectorTemplateLike } from "./connection-catalog.ts";
import { canonicalConnectorKey } from "./connection-modality.ts";

/**
 * Which connectors this server can enroll a local collector for.
 *
 * The answer comes from the server's owner connector templates, not from a key
 * list in the console. A template offers local-collector enrollment when the
 * shared setup planner, reading the connector's own manifest, picked the
 * `local_collector_enroll` disposition and gave it an enrollment key. A connector
 * installed after this console was built therefore behaves like a bundled one.
 */

export type LocalCollectorTemplate = Pick<
  OwnerConnectorTemplateLike,
  "connector_id" | "connector_key" | "setup_plan"
>;

function enrollableEntries(
  templates: readonly LocalCollectorTemplate[]
): { canonicalKey: string; enrollmentKey: string }[] {
  const entries: { canonicalKey: string; enrollmentKey: string }[] = [];
  for (const template of templates) {
    const plan = template.setup_plan;
    const enrollmentKey = typeof plan?.enrollment_key === "string" ? plan.enrollment_key.trim() : "";
    const identity = template.connector_key ?? template.connector_id;
    if (plan?.catalog_disposition !== "local_collector_enroll" || !enrollmentKey || !identity) {
      continue;
    }
    entries.push({ canonicalKey: canonicalConnectorKey(identity), enrollmentKey });
  }
  return entries;
}

/** Enrollment keys of every connector the server can enroll, in template order, without duplicates. */
export function localCollectorEnrollmentKeys(templates: readonly LocalCollectorTemplate[]): string[] {
  return [...new Set(enrollableEntries(templates).map((entry) => entry.enrollmentKey))];
}

/**
 * The enrollment key for a connector id, or null when the server cannot enroll
 * it. Accepts the enrollment key, the canonical key, or the registry-URL form.
 */
export function resolveLocalCollectorEnrollmentKey(
  templates: readonly LocalCollectorTemplate[],
  connectorId: string | null | undefined
): string | null {
  const requested = connectorId?.trim();
  if (!requested) {
    return null;
  }
  const canonical = canonicalConnectorKey(requested);
  const match = enrollableEntries(templates).find(
    (entry) => entry.enrollmentKey === requested || entry.canonicalKey === canonical
  );
  return match?.enrollmentKey ?? null;
}
