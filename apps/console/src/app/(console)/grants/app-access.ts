// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { formatSourceForDisplay, formatRelative, grantRowLabel } from "@pdpp/display";
import type { GrantSummary } from "../lib/ref-client.ts";

export interface AppAccess {
  grantIds: string[];
  hrefId: string;
  lastRead: string | null;
  name: string;
  sources: string[];
  status: string | null;
}

const ACTIVE_STATUSES = new Set(["active", "issued"]);

function statusWord(status: string): string | null {
  if (ACTIVE_STATUSES.has(status)) return null;
  if (status === "revoked") return "Removed";
  if (status === "denied") return "Not allowed";
  if (status === "failed") return "Failed";
  if (status === "pending") return "Waiting";
  return "Status not available";
}

export function appSourceName(source: GrantSummary["source"]): string | null {
  if (!source) return null;
  const label = formatSourceForDisplay(source).replace(/^provider_native:/, "");
  return label ? `${label[0]?.toUpperCase()}${label.slice(1)}` : label;
}

export function groupGrantAccessByApp(grants: readonly GrantSummary[]): AppAccess[] {
  const groups = new Map<string, { app: AppAccess; statuses: string[] }>();
  for (const grant of grants) {
    const key = grant.client_id || grant.grant_id;
    let group = groups.get(key);
    if (!group) {
      group = {
        app: {
          grantIds: [],
          hrefId: grant.grant_id,
          lastRead: null,
          name: grant.client?.client_name?.trim() || "App",
          sources: [],
          status: null,
        },
        statuses: [],
      };
      groups.set(key, group);
    }
    if (ACTIVE_STATUSES.has(grant.status)) {
      group.app.grantIds.push(grant.grant_id);
      group.app.hrefId = grant.grant_id;
    }
    if (grant.last_at && (!group.app.lastRead || grant.last_at > group.app.lastRead)) {
      group.app.lastRead = grant.last_at;
    }
    group.statuses.push(grant.status);
    const source = appSourceName(grant.source) ?? grant.connector_id ?? grantRowLabel(grant);
    if (source && !group.app.sources.includes(source)) group.app.sources.push(source);
  }

  return [...groups.values()]
    .map(({ app, statuses }) => {
      app.status = statuses.some((status) => ACTIVE_STATUSES.has(status))
        ? null
        : statusWord(statuses[0] ?? "");
      return app;
    })
    .sort((left, right) => left.name.localeCompare(right.name));
}

export function formatAppLastRead(value: string | null, now = Date.now()): string {
  if (!value) return "No reads yet";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Time not available" : formatRelative(date, now);
}
