// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// DR demo: the owner's grants as citizen "authorizations" (Mis autorizaciones).
//
// One consent can issue several grants (one per source, bound in a grant
// package); the citizen sees them as ONE authorization and revokes them
// together.
//
//   /_ref/grants summaries ─┐
//   grant rows (expires_at) ├─▶ listCitizenAuthorizations() ─▶ [authorization]
//   grant timelines (reads) ┘        grouped by grant_package_id, newest first
//
// Reads come from the same spine timeline the console's /grants view uses.

import { executeRefSpineCorrelationsList } from "../operations/ref-spine-correlations-list/index.ts";
import { isInternalConnectorId } from "./connector-key.ts";

export type CitizenGrantStatus = "active" | "expired" | "revoked";

export interface CitizenStream {
  fields: string[];
  name: string;
}

export interface CitizenSource {
  id: string;
  name: string;
  streams: CitizenStream[];
}

export interface CitizenRead {
  at: string;
  stream: string;
}

export interface CitizenAuthorization {
  clientName: string;
  expiresAt: string | null;
  grantIds: string[];
  issuedAt: string;
  purposeCode: string | null;
  purposeDescription: string | null;
  reads: CitizenRead[];
  revokedAt: string | null;
  sources: CitizenSource[];
  status: CitizenGrantStatus;
}

interface GrantRow {
  expiresAt: string | null;
  grantJson: string;
}

interface SpineEventLike {
  data?: unknown;
  event_type: string;
  occurred_at: string;
  stream_id?: string | null;
}

export interface CitizenGrantsDeps {
  listGrantEvents: (grantId: string) => Promise<SpineEventLike[]>;
  listSpineCorrelations: Parameters<typeof executeRefSpineCorrelationsList>[1]["listSpineCorrelations"];
  readGrant: (grantId: string) => Promise<GrantRow | null>;
}

export interface CitizenRevokeDeps {
  packageIdForGrant: (grantId: string) => Promise<string | null>;
  revokeGrant: (grantId: string) => Promise<void>;
  revokePackage: (packageId: string) => Promise<void>;
}

// Newest grants first; the demo owner has a handful.
const GRANT_LIST_LIMIT = 200;
const EVENT_GRANT_ISSUED = "grant.issued";
const EVENT_GRANT_REVOKED = "grant.revoked";
const EVENT_DISCLOSURE = "disclosure.served";

/** One grant, before grouping. */
interface CitizenGrant {
  clientName: string;
  expiresAt: string | null;
  grantId: string;
  issuedAt: string;
  packageId: string | null;
  purposeCode: string | null;
  purposeDescription: string | null;
  reads: CitizenRead[];
  revokedAt: string | null;
  source: CitizenSource;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function parseJson(text: string): Record<string, unknown> {
  try {
    return asRecord(JSON.parse(text));
  } catch {
    return {};
  }
}

function grantStreams(grant: Record<string, unknown>): CitizenStream[] {
  const streams = Array.isArray(grant.streams) ? grant.streams : [];
  return streams.flatMap((raw) => {
    const stream = asRecord(raw);
    const name = asString(stream.name);
    if (!name) {
      return [];
    }
    const fields = Array.isArray(stream.fields) ? stream.fields.filter((f): f is string => typeof f === "string") : [];
    return [{ fields, name }];
  });
}

/** "SNS · Servicio Nacional de Salud (demo)" from the grant.issued declaration snapshot. */
function sourceDisplayName(events: SpineEventLike[], fallback: string): string {
  const issued = events.find((event) => event.event_type === EVENT_GRANT_ISSUED);
  const snapshot = asRecord(asRecord(issued?.data).source_declaration_snapshot);
  const display = asRecord(asRecord(snapshot.declaration).display);
  return asString(display.name) ?? fallback;
}

async function loadGrant(
  deps: CitizenGrantsDeps,
  summary: {
    client?: { client_name: string | null };
    client_id: string | null;
    grant_id: string;
    grant_package_id?: string;
  }
): Promise<CitizenGrant | null> {
  const row = await deps.readGrant(summary.grant_id);
  if (!row) {
    return null;
  }
  const grant = parseJson(row.grantJson);
  const events = await deps.listGrantEvents(summary.grant_id);
  const sourceId = asString(asRecord(grant.source).id) ?? "";

  // What was read and when: one entry per disclosure, newest first.
  const reads = events
    .filter((event) => event.event_type === EVENT_DISCLOSURE)
    .map((event) => ({ at: event.occurred_at, stream: event.stream_id ?? "" }))
    .reverse();
  const revoked = events.find((event) => event.event_type === EVENT_GRANT_REVOKED);

  return {
    clientName: summary.client?.client_name ?? summary.client_id ?? "",
    expiresAt: row.expiresAt,
    grantId: summary.grant_id,
    issuedAt: asString(grant.issued_at) ?? events[0]?.occurred_at ?? "",
    packageId: summary.grant_package_id ?? null,
    purposeCode: asString(grant.purpose_code),
    purposeDescription: asString(grant.purpose_description),
    reads,
    revokedAt: revoked?.occurred_at ?? null,
    source: { id: sourceId, name: sourceDisplayName(events, sourceId), streams: grantStreams(grant) },
  };
}

function statusOf(grants: CitizenGrant[], now: number): CitizenGrantStatus {
  if (grants.every((grant) => grant.revokedAt)) {
    return "revoked";
  }
  const expiresAt = grants[0]?.expiresAt;
  if (expiresAt && Date.parse(expiresAt) <= now) {
    return "expired";
  }
  return "active";
}

/** Grants that came from one consent (same package) become one authorization. */
function groupAuthorizations(grants: CitizenGrant[], now: number): CitizenAuthorization[] {
  const groups = new Map<string, CitizenGrant[]>();
  for (const grant of grants) {
    const key = grant.packageId ?? grant.grantId;
    groups.set(key, [...(groups.get(key) ?? []), grant]);
  }

  return [...groups.values()].map((members) => {
    const [first] = members as [CitizenGrant, ...CitizenGrant[]];
    const reads = members.flatMap((grant) => grant.reads).sort((a, b) => b.at.localeCompare(a.at));
    const revokedAt = members.map((grant) => grant.revokedAt).find(Boolean) ?? null;
    return {
      clientName: first.clientName,
      expiresAt: first.expiresAt,
      grantIds: members.map((grant) => grant.grantId),
      issuedAt: first.issuedAt,
      purposeCode: first.purposeCode,
      purposeDescription: first.purposeDescription,
      reads,
      revokedAt,
      sources: members.map((grant) => grant.source),
      status: statusOf(members, now),
    };
  });
}

/** The owner's authorizations, newest first. */
export async function listCitizenAuthorizations(
  deps: CitizenGrantsDeps,
  now: number = Date.now()
): Promise<CitizenAuthorization[]> {
  const envelope = await executeRefSpineCorrelationsList(
    { filters: { limit: GRANT_LIST_LIMIT }, kind: "grant" },
    { isInternalConnectorId, listSpineCorrelations: deps.listSpineCorrelations }
  );
  const summaries = envelope.data as readonly Parameters<typeof loadGrant>[1][];
  const grants = (await Promise.all(summaries.map((summary) => loadGrant(deps, summary)))).filter(
    (grant): grant is CitizenGrant => grant !== null
  );
  // Newest first; stable member order inside one consent.
  grants.sort((a, b) => b.issuedAt.localeCompare(a.issuedAt) || a.grantId.localeCompare(b.grantId));
  return groupAuthorizations(grants, now);
}

/** Revoke one authorization: its whole package when the grant has one. */
export async function revokeCitizenAuthorization(deps: CitizenRevokeDeps, grantId: string): Promise<void> {
  const packageId = await deps.packageIdForGrant(grantId);
  if (packageId) {
    await deps.revokePackage(packageId);
    return;
  }
  await deps.revokeGrant(grantId);
}
