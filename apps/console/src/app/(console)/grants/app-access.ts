// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { formatConnectorKeyForDisplay, formatRelative, formatSourceForDisplay, grantRowLabel } from "@pdpp/display";
import type { GrantPackageChild, GrantSummary, OwnerIssuedClient } from "../lib/ref-client.ts";

export interface AppAccess {
  /** Active access outside any package; removed one by one. */
  grantIds: string[];
  hrefId: string;
  lastRead: string | null;
  name: string;
  /** Packages holding active access; removed whole, so the package and its tokens end too. */
  packageIds: string[];
  sources: string[];
  stoppedAt: string | null;
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

export function appSourceName(source: Parameters<typeof formatSourceForDisplay>[0] | null | undefined): string | null {
  if (!source) return null;
  if (source.kind === "connector") {
    const label = formatConnectorKeyForDisplay(source.connector_id ?? source.id);
    return `${label[0]?.toUpperCase()}${label.slice(1)}`;
  }
  const label = formatSourceForDisplay(source).replace(/^provider_native:/, "");
  return label ? `${label[0]?.toUpperCase()}${label.slice(1)}` : label;
}

export function activePackageAccesses<T extends Pick<GrantPackageChild, "grant_status" | "member_status">>(children: readonly T[]): T[] {
  return children.filter((child) => child.grant_status === "active" && child.member_status === "active");
}

/** Index app display names from grant and owner-client reads by client id. */
export function appNamesByClientId(
  grants: readonly Pick<GrantSummary, "client" | "client_id">[],
  clients: readonly OwnerIssuedClient[] = [],
): Map<string, string> {
  const names = new Map<string, string>();
  for (const grant of grants) {
    const name = grant.client?.client_name?.trim();
    if (grant.client_id && name) names.set(grant.client_id, name);
  }
  for (const client of clients) {
    const name = client.client_name?.trim();
    if (name && !names.has(client.client_id)) names.set(client.client_id, name);
  }
  return names;
}

/**
 * Title for a waiting request. The approval read carries only `client_id`, so
 * the name comes from the app's existing access. No host fallback: an identity
 * made on Connect an app has a `client_id` on this server's own host
 * (`/oauth/client-metadata/…`), and any app can pick a host shaped like a
 * trusted name (`chatgpt.com.example.io`).
 */
export function pendingApprovalAppName(clientName: string | null | undefined): string {
  return clientName?.trim() || "An app";
}

export function groupGrantAccessByApp(grants: readonly GrantSummary[]): AppAccess[] {
  const groups = new Map<string, { app: AppAccess; statuses: string[] }>();
  const names = appNamesByClientId(grants);
  for (const grant of grants) {
    const key = grant.client_id || grant.grant_id;
    const isActive = ACTIVE_STATUSES.has(grant.status);
    let group = groups.get(key);
    if (!group) {
      group = {
        app: {
          grantIds: [],
          hrefId: grant.grant_id,
          lastRead: null,
          name: names.get(key) || "App",
          packageIds: [],
          sources: [],
          stoppedAt: null,
          status: null,
        },
        statuses: [],
      };
      groups.set(key, group);
    }
    if (isActive) {
      const packageId = grant.grant_package_id;
      if (packageId) {
        if (!group.app.packageIds.includes(packageId)) group.app.packageIds.push(packageId);
      } else {
        group.app.grantIds.push(grant.grant_id);
      }
      group.app.hrefId = grant.grant_id;
    }
    if (grant.last_at && (!group.app.lastRead || grant.last_at > group.app.lastRead)) {
      group.app.lastRead = grant.last_at;
    }
    if (grant.status === "revoked" && grant.last_at && (!group.app.stoppedAt || grant.last_at > group.app.stoppedAt)) {
      group.app.stoppedAt = grant.last_at;
    }
    group.statuses.push(grant.status);
    const source =
      appSourceName(grant.source) ??
      (grant.connector_id ? formatConnectorKeyForDisplay(grant.connector_id) : null) ??
      grantRowLabel(grant);
    if (isActive && source && !group.app.sources.includes(source)) group.app.sources.push(source);
  }

  return [...groups.values()]
    .map(({ app, statuses }) => {
      app.status = statuses.some((status) => ACTIVE_STATUSES.has(status))
        ? null
        : statusWord(statuses[0] ?? "");
      if (!statuses.every((status) => status === "revoked")) app.stoppedAt = null;
      return app;
    })
    .sort((left, right) => left.name.localeCompare(right.name));
}

export function splitAppAccessGroups(apps: readonly AppAccess[]): {
  other: AppAccess[];
  reading: AppAccess[];
  stopped: AppAccess[];
} {
  const reading: AppAccess[] = [];
  const stopped: AppAccess[] = [];
  const other: AppAccess[] = [];
  for (const app of apps) {
    if (app.status === null) reading.push(app);
    else if (app.status === "Removed") stopped.push(app);
    else other.push(app);
  }
  return { other, reading, stopped };
}

export function formatAppLastRead(value: string | null, now = Date.now()): string {
  if (!value) return "No reads yet";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Time not available" : formatRelative(date, now);
}
