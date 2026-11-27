// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import {
  formatConnectorNameForDisplay,
  formatRelative,
  humanizeFieldLabel,
  type SourceDisplayInput,
} from "@pdpp/display";
import { connectionDisplayName } from "../lib/connection-display-name.ts";
import { mergeAppAccessSources } from "pdpp-reference-implementation/app-access";
import type { GrantPackageChild, GrantSummary, OwnerIssuedClient } from "../lib/ref-client.ts";

export interface AppAccess {
  offset?: number;
  clientIds: string[];
  expiresAt: string | null;
  grantIds: string[];
  hrefId: string;
  lastRead: string | null;
  name: string;
  neverRead?: boolean;
  packageIds: string[];
  pendingId?: string;
  place: string;
  readsAllSources?: boolean;
  showPlace?: boolean;
  since: string | null;
  sourceAccess: (import("../lib/ref-client.ts").AppAccessSource & {
    name?: string;
    kindNames?: string[];
    neverRead?: boolean;
  })[];
  sources: string[];
  state: "reading" | "stopped" | "waiting";
  status: string | null;
  stoppedAt: string | null;
  stoppedReason: "removed" | "expired" | null;
  verified: boolean;
}

export function appSourceName(source: SourceDisplayInput | null | undefined): string | null {
  if (!source) {
    return null;
  }
  const connectorId = source.connector_id ?? source.id;
  const service = formatConnectorNameForDisplay({ connectorId });
  return connectionDisplayName(
    null,
    service === service.toLowerCase() ? humanizeFieldLabel(service) : service,
    connectorId
  );
}

export function activePackageAccesses<T extends Pick<GrantPackageChild, "grant_status" | "member_status">>(
  children: readonly T[]
): T[] {
  return children.filter((child) => child.grant_status === "active" && child.member_status === "active");
}

/** Index app display names from grant and owner-client reads by client id. */
export function appNamesByClientId(
  grants: readonly Pick<GrantSummary, "client" | "client_id">[],
  clients: readonly OwnerIssuedClient[] = []
): Map<string, string> {
  const names = new Map<string, string>();
  for (const grant of grants) {
    const name = grant.client?.client_name?.trim();
    if (grant.client_id && name) {
      names.set(grant.client_id, name);
    }
  }
  for (const client of clients) {
    const name = client.client_name?.trim();
    if (name && !names.has(client.client_id)) {
      names.set(client.client_id, name);
    }
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
/** The one name every page uses for an app that did not give a usable name. */
export const UNKNOWN_APP_NAME = "An app that gave no name";

export function pendingApprovalAppName(clientName: string | null | undefined): string {
  return clientName?.trim() || UNKNOWN_APP_NAME;
}

/** Complete registrations only: access comes from permissions, never event outcomes. */
export function groupGrantAccessByApp(
  registrations: readonly import("../lib/ref-client.ts").AppAccess[],
  now = Date.now(),
  pending: readonly import("../lib/ref-client.ts").PendingApproval[] = [],
  sourceNames: ReadonlyMap<string, string> = new Map()
): AppAccess[] {
  const groups = new Map<string, AppAccess>();
  for (const registration of registrations) {
    const name = registration.client_name.trim();
    const place = registration.returns_to_this_computer
      ? "this computer"
      : registration.return_host || "no address given";
    const key =
      registration.client_name_source !== "client_id" &&
      (name || registration.return_host || registration.returns_to_this_computer)
        ? JSON.stringify([name, place])
        : registration.client_id;
    let app = groups.get(key);
    if (!app) {
      app = {
        clientIds: [],
        grantIds: [],
        hrefId: "",
        lastRead: null,
        name: name || (place === "no address given" ? UNKNOWN_APP_NAME : place),
        place,
        verified: true,
        packageIds: [],
        sources: [],
        sourceAccess: [],
        since: null,
        expiresAt: null,
        stoppedAt: null,
        stoppedReason: null,
        state: "stopped",
        status: "Removed",
      };
      groups.set(key, app);
    }
    app.clientIds.push(registration.client_id);
    app.verified &&= registration.domain_control_verified;
    for (const row of registration.sources) {
      const inForce = row.in_force && (!row.expires_at || Date.parse(row.expires_at) > now);
      const identity = JSON.stringify(row.source);
      const previous = app.sourceAccess.find((item) => JSON.stringify(item.source) === identity);
      if (previous) {
        const wasInForce = previous.in_force;
        previous.in_force ||= inForce;
        // Only grants in force say what the app can read now; a stopped one adds nothing to an active one.
        previous.kinds = wasInForce && !inForce ? previous.kinds
          : !wasInForce && inForce ? [...row.kinds]
          : [...new Set([...previous.kinds, ...row.kinds])];
        previous.grant_ids = [...new Set([...previous.grant_ids, ...row.grant_ids])];
        previous.active_grant_ids = [
          ...new Set([...previous.active_grant_ids, ...(inForce ? row.active_grant_ids : [])]),
        ];
        previous.package_ids = [...new Set([...previous.package_ids, ...row.package_ids])];
        if (row.first_issued_at < previous.first_issued_at) {
          previous.first_issued_at = row.first_issued_at;
        }
        if (row.last_read_at && (!previous.last_read_at || row.last_read_at > previous.last_read_at)) {
          previous.last_read_at = row.last_read_at;
        }
        if (row.stopped_at && (!previous.stopped_at || row.stopped_at > previous.stopped_at)) {
          previous.stopped_at = row.stopped_at;
          previous.stopped_reason = row.stopped_reason;
        }
        if (inForce) {
          previous.expires_at = wasInForce
            ? previous.expires_at && row.expires_at
              ? previous.expires_at > row.expires_at
                ? previous.expires_at
                : row.expires_at
              : null
            : row.expires_at;
        }
      } else {
        app.sourceAccess.push({
          ...row,
          name: row.all_accounts
            ? `All ${appSourceName(row.source)} accounts`
            : sourceNames.get(row.source.connection_id || "") || appSourceName(row.source) || "Data source",
          in_force: inForce,
          kinds: [...row.kinds],
          grant_ids: [...row.grant_ids],
          active_grant_ids: inForce ? [...row.active_grant_ids] : [],
          package_ids: [...row.package_ids],
        });
      }
      app.grantIds = [...new Set([...app.grantIds, ...row.grant_ids])];
    }
  }
  for (const app of groups.values()) {
    const current = app.sourceAccess.filter((source) => source.in_force);
    app.hrefId = app.grantIds[0] || app.clientIds[0] || "";
    app.state = current.length ? "reading" : "stopped";
    app.status = current.length ? null : "Removed";
    const visible = current.length ? current : app.sourceAccess;
    app.sources = visible.map((row) => row.name || appSourceName(row.source) || "Data source");
    app.readsAllSources =
      sourceNames.size > 0 &&
      [...sourceNames.keys()].every((id) =>
        current.some((row) => row.source.connection_id === id || row.connection_ids?.includes(id))
      );
    if (sourceNames.size) {
      const expanded = app.sourceAccess.flatMap(row => {
        const ids = row.all_accounts ? (row.connection_ids ?? []).filter(id => sourceNames.has(id)) : [];
        if (!ids.length) { return row.source.connection_id && sourceNames.has(row.source.connection_id) ? [row] : []; }
        return ids.map(id => ({ ...row, all_accounts: false, connection_ids: [id], source: { ...row.source, connection_id: id } }));
      });
      let rows = mergeAppAccessSources(expanded.filter(row=>app.state !== "reading" || row.in_force)).map(row => ({...row, name: sourceNames.get(row.source.connection_id || "") || appSourceName(row.source) || "Data source"}));
      if (!app.readsAllSources) {
        for (const wide of app.sourceAccess.filter(row => row.all_accounts && (app.state !== "reading" || row.in_force))) {
          const ids = (wide.connection_ids ?? []).filter(id => sourceNames.has(id));
          if (ids.length < 2) { continue; }
          const accounts = rows.filter(row => ids.includes(row.source.connection_id || ""));
          const [combined] = mergeAppAccessSources(accounts.map(row => ({...row, source: {...wide.source, connection_id: null}})));
          if (!combined) { continue; }
          rows = rows.filter(row => !ids.includes(row.source.connection_id || ""));
          rows.push({...combined, all_accounts: true, connection_ids: ids, name: `All ${appSourceName(wide.source)} accounts`});
        }
      }
      app.sourceAccess = rows;
      app.sources = rows.filter(row => app.state !== "reading" || row.in_force).map(row=>row.name);
    }
    app.since = visible.map((row) => row.first_issued_at).sort()[0] || null;
    app.lastRead =
      visible
        .flatMap((row) => (row.last_read_at ? [row.last_read_at] : []))
        .sort()
        .at(-1) || null;
    app.expiresAt =
      current.length && current.every((row) => row.expires_at)
        ? current
            .map((row) => row.expires_at as string)
            .sort()
            .at(-1) || null
        : null;
    const stopped = app.sourceAccess
      .filter((row) => row.stopped_at)
      .sort((a, b) => (b.stopped_at || "").localeCompare(a.stopped_at || ""))[0];
    app.stoppedAt = stopped?.stopped_at || null;
    app.stoppedReason =
      stopped?.stopped_reason ||
      (app.sourceAccess.some((row) => row.expires_at && Date.parse(row.expires_at) <= now) ? "expired" : "removed");
  }
  for (const app of groups.values()) {
    app.showPlace = [...groups.values()].some((other) => other !== app && other.name === app.name);
  }
  const waiting = pending.map((request): AppAccess => {
    const known = [...groups.values()].find((app) => app.clientIds.includes(request.client_id || ""));
    return {
      clientIds: request.client_id ? [request.client_id] : [],
      grantIds: [],
      hrefId: request.approval_id,
      name: known?.name || UNKNOWN_APP_NAME,
      place: known?.place || "no address given",
      verified: known?.verified || false,
      packageIds: [],
      sources: request.grant_preview?.source ? [appSourceName(request.grant_preview.source) || "your data"] : [],
      sourceAccess: [],
      since: request.created_at,
      expiresAt: null,
      lastRead: null,
      stoppedAt: null,
      stoppedReason: null,
      state: "waiting",
      status: "Waiting for you",
      pendingId: request.approval_id,
    };
  });
  return [
    ...waiting,
    ...[...groups.values()].sort(
      (a, b) => (b.lastRead || "").localeCompare(a.lastRead || "") || a.name.localeCompare(b.name)
    ),
  ];
}

export function formatAppLastRead(value: string | null, now = Date.now()): string {
  if (!value) {
    return "Has not read anything yet";
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Time not available" : formatRelative(date, now);
}
