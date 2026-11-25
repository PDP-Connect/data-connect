// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { formatSourceForDisplay, formatRelative, grantRowLabel } from "@pdpp/display";
import type { GrantPackageChild, GrantSummary } from "../lib/ref-client.ts";

export interface AppAccess {
  /** Active access outside any package; removed one by one. */
  grantIds: string[];
  hrefId: string;
  lastRead: string | null;
  name: string;
  /** Packages holding active access; removed whole, so the package and its tokens end too. */
  packageIds: string[];
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

export function appSourceName(source: Parameters<typeof formatSourceForDisplay>[0] | null | undefined): string | null {
  if (!source) return null;
  const label = formatSourceForDisplay(source).replace(/^provider_native:/, "");
  return label ? `${label[0]?.toUpperCase()}${label.slice(1)}` : label;
}

export function activePackageAccesses<T extends Pick<GrantPackageChild, "grant_status" | "member_status">>(children: readonly T[]): T[] {
  return children.filter((child) => child.grant_status === "active" && child.member_status === "active");
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
          name: grant.client?.client_name?.trim() || "App",
          packageIds: [],
          sources: [],
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
    group.statuses.push(grant.status);
    const source = appSourceName(grant.source) ?? grant.connector_id ?? grantRowLabel(grant);
    if (isActive && source && !group.app.sources.includes(source)) group.app.sources.push(source);
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
