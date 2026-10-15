// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// AS-side pilot state: which person approved which grant (AS-internal, never
// returned to clients), the representative review bound to a core review
// revision, and the keep-or-delete choice recorded on revocation.

import { createHmac, randomBytes } from "node:crypto";
import { postgresQuery } from "../postgres-storage.ts";
import type { Grantor } from "./grantors.ts";

export const PILOT_STORE_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS pilot_rep_settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS pilot_rep_reviews (
    device_code    TEXT PRIMARY KEY,
    parent_ref     TEXT NOT NULL,
    child_id       TEXT NOT NULL,
    capacity       TEXT NOT NULL,
    grantors_json  JSONB NOT NULL,
    core_revision  TEXT NOT NULL,
    pilot_revision TEXT NOT NULL,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE TABLE IF NOT EXISTS pilot_rep_grants (
    grant_id      TEXT PRIMARY KEY,
    child_id      TEXT NOT NULL,
    client_id     TEXT NOT NULL,
    parent_ref    TEXT NOT NULL,
    parent_cedula TEXT NOT NULL,
    capacity      TEXT NOT NULL,
    grantor_id    TEXT NOT NULL,
    approved_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    revoked_at    TIMESTAMPTZ,
    revoked_by    TEXT,
    disposition   TEXT CHECK (disposition IN ('keep', 'delete')),
    client_name   TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_pilot_rep_grants_child ON pilot_rep_grants (child_id);
`;

let pairwiseKey: Buffer | null = null;

export async function ensurePilotStoreSchema(): Promise<void> {
  await postgresQuery(PILOT_STORE_SCHEMA_SQL);
  await postgresQuery(
    "INSERT INTO pilot_rep_settings (key, value) VALUES ('pairwise_key', $1) ON CONFLICT (key) DO NOTHING",
    [randomBytes(32).toString("base64url")]
  );
  const result = await postgresQuery("SELECT value FROM pilot_rep_settings WHERE key = 'pairwise_key'");
  pairwiseKey = Buffer.from(String(result.rows[0]?.value), "base64url");
}

/**
 * #378: "For grants returned to clients, the AS MUST use an identifier specific
 * to that client." Stable per (client, person), unlinkable across clients.
 */
export function pairwiseGrantorId(clientId: string, parentRef: string): string {
  if (!pairwiseKey) {
    throw new Error("pilot store not initialised");
  }
  return `gtr_${createHmac("sha256", pairwiseKey).update(`${clientId}\n${parentRef}`).digest("base64url").slice(0, 27)}`;
}

export interface RepresentativeReviewRow {
  capacity: string;
  child_id: string;
  core_revision: string;
  device_code: string;
  grantors: Grantor[];
  parent_ref: string;
  pilot_revision: string;
}

export async function saveRepresentativeReview(row: RepresentativeReviewRow): Promise<void> {
  await postgresQuery(
    `INSERT INTO pilot_rep_reviews (device_code, parent_ref, child_id, capacity, grantors_json, core_revision, pilot_revision)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7)
     ON CONFLICT (device_code) DO UPDATE
       SET parent_ref = EXCLUDED.parent_ref, child_id = EXCLUDED.child_id, capacity = EXCLUDED.capacity,
           grantors_json = EXCLUDED.grantors_json, core_revision = EXCLUDED.core_revision,
           pilot_revision = EXCLUDED.pilot_revision, created_at = now()`,
    [
      row.device_code,
      row.parent_ref,
      row.child_id,
      row.capacity,
      JSON.stringify(row.grantors),
      row.core_revision,
      row.pilot_revision,
    ]
  );
}

export async function getRepresentativeReview(deviceCode: string): Promise<RepresentativeReviewRow | null> {
  const result = await postgresQuery(
    `SELECT device_code, parent_ref, child_id, capacity, grantors_json, core_revision, pilot_revision
       FROM pilot_rep_reviews WHERE device_code = $1`,
    [deviceCode]
  );
  const row = result.rows[0];
  if (!row) {
    return null;
  }
  return {
    capacity: String(row.capacity),
    child_id: String(row.child_id),
    core_revision: String(row.core_revision),
    device_code: String(row.device_code),
    grantors: row.grantors_json as Grantor[],
    parent_ref: String(row.parent_ref),
    pilot_revision: String(row.pilot_revision),
  };
}

export interface RepresentativeGrantRow {
  approved_at: string;
  capacity: string;
  child_id: string;
  client_display_name: string | null;
  client_id: string;
  disposition: string | null;
  expires_at: string | null;
  /** Fields the grant shares, from the resolved grant (display only). */
  fields: string[];
  grant_id: string;
  grant_status: string;
  parent_ref: string;
  purpose_description: string | null;
  revoked_at: string | null;
}

function iso(value: unknown): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  return value instanceof Date ? value.toISOString() : String(value);
}

const GRANT_LIST_SQL = `
  SELECT p.grant_id, p.child_id, p.client_id, p.parent_ref, p.capacity, p.approved_at, p.revoked_at,
         p.disposition, g.status AS grant_status, g.expires_at,
         g.grant_json -> 'streams' AS streams_json, g.grant_json ->> 'purpose_description' AS purpose_description,
         COALESCE(p.client_name, g.grant_json -> 'client' -> 'client_display' ->> 'name') AS client_display_name
    FROM pilot_rep_grants p
    JOIN grants g ON g.grant_id = p.grant_id`;

function grantFields(streams: unknown): string[] {
  if (!Array.isArray(streams)) {
    return [];
  }
  const fields = streams.flatMap((s) => (Array.isArray(s?.fields) ? (s.fields as unknown[]).map(String) : []));
  return [...new Set(fields)];
}

function toGrantRow(row: Record<string, unknown>): RepresentativeGrantRow {
  return {
    approved_at: iso(row.approved_at) as string,
    capacity: String(row.capacity),
    child_id: String(row.child_id),
    client_display_name: (row.client_display_name as string | null) ?? null,
    client_id: String(row.client_id),
    disposition: (row.disposition as string | null) ?? null,
    expires_at: iso(row.expires_at),
    fields: grantFields(row.streams_json),
    grant_id: String(row.grant_id),
    grant_status: String(row.grant_status),
    parent_ref: String(row.parent_ref),
    purpose_description: (row.purpose_description as string | null) ?? null,
    revoked_at: iso(row.revoked_at),
  };
}

export async function listGrantsForChildren(childIds: string[]): Promise<RepresentativeGrantRow[]> {
  if (childIds.length === 0) {
    return [];
  }
  const result = await postgresQuery(`${GRANT_LIST_SQL} WHERE p.child_id = ANY($1) ORDER BY p.approved_at DESC`, [
    childIds,
  ]);
  return result.rows.map(toGrantRow);
}

export async function getRepresentativeGrant(grantId: string): Promise<RepresentativeGrantRow | null> {
  const result = await postgresQuery(`${GRANT_LIST_SQL} WHERE p.grant_id = $1`, [grantId]);
  const row = result.rows[0];
  return row ? toGrantRow(row) : null;
}

export async function recordRevocation(grantId: string, parentRef: string, disposition: "keep" | "delete") {
  await postgresQuery(
    `UPDATE pilot_rep_grants SET revoked_at = now(), revoked_by = $2, disposition = $3
      WHERE grant_id = $1 AND revoked_at IS NULL`,
    [grantId, parentRef, disposition]
  );
}

export const INSERT_REPRESENTATIVE_GRANT_SQL = `
  INSERT INTO pilot_rep_grants (grant_id, child_id, client_id, parent_ref, parent_cedula, capacity, grantor_id, client_name)
  VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`;
