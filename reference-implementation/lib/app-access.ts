// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

export type {
  RemoveAppAccessInput,
  RemoveAppAccessResult,
} from "./remove-app-access.ts";

export interface AppAccessSourceIdentity {
  kind: "connector" | "provider_native";
  id: string;
  connector_id: string | null;
  connection_id: string | null;
}

export interface AppAccessSource {
  source: AppAccessSourceIdentity;
  kinds: string[];
  in_force: boolean;
  first_issued_at: string;
  expires_at: string | null;
  stopped_at: string | null;
  stopped_reason: "removed" | "expired" | null;
  last_read_at: string | null;
  grant_ids: string[];
  active_grant_ids: string[];
  package_ids: string[];
}

export interface AppAccess {
  client_id: string;
  client_name: string;
  client_name_source?: "registration" | "stored" | "client_id" | null;
  return_host: string | null;
  returns_to_this_computer: boolean;
  domain_control_verified: boolean;
  sources: AppAccessSource[];
  reads_last_7_days: number;
}

export interface AppAccessGrantRow {
  grant_id: string;
  client_id: string;
  status: string;
  issued_at: string;
  expires_at: string | null;
  grant_json: unknown;
  storage_binding_json: unknown;
  trust_signal_json: unknown;
  metadata_json: unknown;
}

export interface AppAccessEventRow {
  grant_id: string;
  connector_instance_id: string | null;
  last_read_at: string | null;
  revoked_at: string | null;
  reads_last_7_days: string | number;
}

export interface AppAccessMemberRow {
  created_at?: string;
  grant_id: string;
  package_id: string;
  package_json?: unknown;
}
export interface AppAccessInstanceRow {
  client_id: string;
  handle: string;
  internal_id: string;
}

export function jsonObject(value: unknown): Record<string, unknown> {
  if (typeof value === "string") {
    try {
      return jsonObject(JSON.parse(value));
    } catch {
      return {};
    }
  }
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

const LEADING_WWW = /^www\./;

export function sameAppAccessSource(a: AppAccessSourceIdentity, b: AppAccessSourceIdentity): boolean {
  return (
    a.kind === b.kind &&
    a.id === b.id &&
    a.connector_id === b.connector_id &&
    a.connection_id === b.connection_id
  );
}

function later(a: string | null, b: string | null): string | null {
  if (!a) {
    return b;
  }
  return b && Date.parse(b) > Date.parse(a) ? b : a;
}

/** Both stores supply the same persisted facts; event outcome words never enter this projection. */
export function projectAppAccess(
  grants: AppAccessGrantRow[],
  events: AppAccessEventRow[],
  members: AppAccessMemberRow[],
  instances: AppAccessInstanceRow[],
  now: string,
): AppAccess[] {
  const apps = new Map<string, AppAccess>();
  const byGrant = new Map<string, AppAccessEventRow[]>();
  for (const event of events) {
    const group = byGrant.get(event.grant_id) ?? [];
    group.push(event);
    byGrant.set(event.grant_id, group);
  }
  const packages = new Map<string, string[]>();
  for (const member of members) {
    packages.set(member.grant_id, [...(packages.get(member.grant_id) ?? []), member.package_id]);
  }
  const handles = new Map(instances.map((row) => [`${row.client_id}\0${row.handle}`, row.internal_id]));
  const storedNames = new Map<string, { name: string; issuedAt: string }>();
  const rememberName = (clientId: string, envelope: unknown, issuedAt: string) => {
    const name = text(jsonObject(jsonObject(jsonObject(envelope).client).client_display).name)?.trim();
    const previous = storedNames.get(clientId);
    if (name && (!previous || Date.parse(issuedAt) > Date.parse(previous.issuedAt) ||
      (Date.parse(issuedAt) === Date.parse(previous.issuedAt) && name.localeCompare(previous.name) < 0))) {
      storedNames.set(clientId, { issuedAt, name });
    }
  };
  const clientsByGrant = new Map(grants.map(row => [row.grant_id, row.client_id]));
  for (const row of grants) {
    rememberName(row.client_id, row.grant_json, row.issued_at);
  }
  for (const member of members) {
    const clientId = clientsByGrant.get(member.grant_id);
    if (clientId && member.created_at) {
      rememberName(clientId, member.package_json, member.created_at);
    }
  }
  for (const row of grants) {
    let app = apps.get(row.client_id);
    if (!app) {
      const metadata = jsonObject(row.metadata_json);
      const registeredName = text(metadata.client_name)?.trim();
      const storedName = storedNames.get(row.client_id)?.name;
      let clientHost: string | null = null;
      if (row.metadata_json === null) {
        try {
          const url = new URL(row.client_id);
          if (url.protocol === "https:" && !url.username && !url.password && !url.hash && url.pathname !== "/") {
            clientHost = url.hostname.toLowerCase();
          }
        } catch {
          /* not a web-address identity */
        }
      }
      let host: string | null = null;
      const redirect = Array.isArray(metadata.redirect_uris) ? metadata.redirect_uris[0] : null;
      if (typeof redirect === "string") {
        try {
          host = new URL(redirect).hostname.replace(/^\[|\]$/g, "").toLowerCase();
        } catch {
          /* absent host */
        }
      }
      host ??= clientHost;
      let nameSource: AppAccess["client_name_source"] = null;
      if (registeredName) {
        nameSource = "registration";
      } else if (storedName) {
        nameSource = "stored";
      } else if (clientHost) {
        nameSource = "client_id";
      }
      app = {
        client_id: row.client_id,
        client_name: registeredName || storedName || clientHost?.replace(LEADING_WWW, "") || "",
        client_name_source: nameSource,
        return_host: host,
        returns_to_this_computer: host !== null && ["localhost", "127.0.0.1", "::1"].includes(host),
        // Unregistered HTTPS identities passed CIMD resolution before issuance:
        // exact-URL HTTPS fetch (no redirects), or issuer-owned same-origin storage.
        domain_control_verified: clientHost !== null,
        sources: [],
        reads_last_7_days: 0,
      };
      apps.set(row.client_id, app);
    }
    app.domain_control_verified ||= jsonObject(row.trust_signal_json).status === "domain_control_verified";
    const grantEvents = byGrant.get(row.grant_id) ?? [];
    const revokedAt = grantEvents.reduce<string | null>(
      (value, event) => later(value, event.revoked_at),
      null,
    );
    app.reads_last_7_days += grantEvents.reduce((count, event) => count + Number(event.reads_last_7_days), 0);
    const grant = jsonObject(row.grant_json);
    const binding = jsonObject(row.storage_binding_json);
    const rawSource = jsonObject(grant.source);
    const connectorId = text(binding.connector_id);
    const sourceId = text(rawSource.id) ?? connectorId ?? "";
    const sourceKind = rawSource.kind === "provider_native" ? "provider_native" : "connector";
    const streams = Array.isArray(grant.streams) ? grant.streams.map(jsonObject) : [];
    const sourceKinds = new Map<string | null, Set<string>>();
    for (const stream of streams) {
      const ids =
        Array.isArray(stream.instance_ids) && stream.instance_ids.length ? stream.instance_ids : [null];
      for (const id of ids) {
        const handle = text(id);
        const connection = handle ? (handles.get(`${row.client_id}\0${handle}`) ?? handle) : null;
        const kinds = sourceKinds.get(connection) ?? new Set<string>();
        const name = text(stream.name);
        if (name) {
          kinds.add(name);
        }
        sourceKinds.set(connection, kinds);
      }
    }
    if (!sourceKinds.size) {
      sourceKinds.set(null, new Set());
    }
    const active =
      row.status === "active" && (!row.expires_at || Date.parse(row.expires_at) > Date.parse(now));
    for (const [connection, kinds] of sourceKinds) {
      const identity: AppAccessSourceIdentity = {
        kind: sourceKind,
        id: sourceId,
        connector_id: connectorId,
        connection_id: connection,
      };
      let source = app.sources.find((entry) => sameAppAccessSource(entry.source, identity));
      if (!source) {
        source = {
          source: identity,
          kinds: [],
          in_force: false,
          first_issued_at: row.issued_at,
          expires_at: null,
          stopped_at: null,
          stopped_reason: null,
          last_read_at: null,
          grant_ids: [],
          active_grant_ids: [],
          package_ids: [],
        };
        app.sources.push(source);
      }
      source.kinds = [...new Set([...source.kinds, ...kinds])].sort();
      source.grant_ids.push(row.grant_id);
      source.package_ids = [
        ...new Set([...source.package_ids, ...(packages.get(row.grant_id) ?? [])]),
      ].sort();
      if (Date.parse(row.issued_at) < Date.parse(source.first_issued_at)) {
        source.first_issued_at = row.issued_at;
      }
      source.last_read_at = later(
        source.last_read_at,
        grantEvents
          .filter(
            (event) =>
              event.connector_instance_id === connection ||
              (event.connector_instance_id === null && sourceKinds.size === 1),
          )
          .reduce<string | null>((value, event) => later(value, event.last_read_at), null),
      );
      if (active) {
        source.expires_at = !source.in_force
          ? row.expires_at
          : source.expires_at === null || row.expires_at === null
            ? null
            : later(source.expires_at, row.expires_at);
        source.in_force = true;
        source.active_grant_ids.push(row.grant_id);
      } else {
        // A durable revoke before expiry stopped access; otherwise the deadline did.
        const revoked =
          row.status === "revoked" &&
          (!row.expires_at || !revokedAt || Date.parse(revokedAt) < Date.parse(row.expires_at));
        const stopped = revoked ? revokedAt : row.expires_at;
        if (
          !source.stopped_reason ||
          (stopped && (!source.stopped_at || Date.parse(stopped) > Date.parse(source.stopped_at)))
        ) {
          source.stopped_at = stopped;
          source.stopped_reason = revoked ? "removed" : row.expires_at ? "expired" : null;
        }
      }
    }
  }
  for (const app of apps.values()) {
    for (const source of app.sources) {
      if (source.in_force) {
        source.stopped_at = null;
        source.stopped_reason = null;
      }
      source.grant_ids.sort();
      source.active_grant_ids.sort();
    }
    app.sources.sort((a, b) => JSON.stringify(a.source).localeCompare(JSON.stringify(b.source)));
  }
  return [...apps.values()].sort((a, b) => a.client_id.localeCompare(b.client_id));
}
