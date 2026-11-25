// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Shared fixture for the connector-wide teardown failure matrix
// (test/records-teardown-failure-matrix.test.ts). One connector with two
// connections, two lexical streams, records with history, blobs shared across
// the two connections (content-addressed cross-reference), and lexical index
// rows; plus an untouched sibling connector used to check isolation.
import { registerConnector } from "../../../server/auth.ts";
import { ingestRecord } from "../../../server/records.ts";
import { lexicalIndexBackfillForManifest } from "../../../server/search.ts";

/** Names for one scenario; a unique `tag` keeps scenarios apart in a shared Postgres database. */
export function fixtureIds(tag: string) {
  return {
    blobs: {
      // Uploaded and bound by A only.
      onlyA: `blob_sha256_td_${tag}_only_a`,
      // Uploaded and bound by B only.
      onlyB: `blob_sha256_td_${tag}_only_b`,
      // Uploaded by B, bound by A and B: the connector-wide teardown visits A first.
      shared: `blob_sha256_td_${tag}_shared`,
      sibling: `blob_sha256_td_${tag}_sibling`,
    },
    connector: `td-${tag}`,
    instanceA: `cin_td_${tag}_a`,
    instanceB: `cin_td_${tag}_b`,
    instanceS: `cin_td_${tag}_s`,
    sibling: `td-${tag}-sib`,
  };
}
export type FixtureIds = ReturnType<typeof fixtureIds>;

export interface Sql {
  exec: (sql: string, params?: unknown[]) => Promise<void>;
  rows: (sql: string, params?: unknown[]) => Promise<Record<string, unknown>[]>;
}

export function manifestFor(connectorId: string) {
  return {
    capabilities: { human_interaction: [] },
    connector_id: connectorId,
    display_name: `Teardown matrix ${connectorId}`,
    manifest_uri: `https://registry.pdpp.dev/connectors/${connectorId}`,
    protocol_version: "0.1.0",
    streams: ["items", "notes"].map((name) => ({
      name,
      primary_key: ["id"],
      query: { search: { lexical_fields: ["subject"] } },
      schema: {
        properties: { id: { type: "string" }, subject: { type: "string" } },
        required: ["id", "subject"],
        type: "object",
      },
      selection: { fields: true, resources: true },
      semantics: "append_only",
    })),
    version: "0.1.0",
  };
}

const NOW = "2026-10-18T00:00:00.000Z";

async function insertInstance(sql: Sql, instanceId: string, connectorId: string): Promise<void> {
  await sql.exec(
    `INSERT INTO connector_instances(
           connector_instance_id, owner_subject_id, connector_id, display_name, status,
           source_kind, source_binding_key, source_binding_json, created_at, updated_at, revoked_at)
         VALUES($1, 'owner_local', $2, $1, 'active', 'account', $1, '{}', $3, $3, NULL)`,
    [instanceId, connectorId, NOW]
  );
}

interface BlobSite {
  connectorId: string;
  instanceId: string;
  key: string;
  stream: string;
}

async function insertBlob(sql: Sql, blobId: string, owner: BlobSite, bindings: BlobSite[]): Promise<void> {
  await sql.exec(
    `INSERT INTO blobs(blob_id, connector_id, connector_instance_id, stream, record_key, mime_type, size_bytes, sha256, data)
         VALUES($1, $2, $3, $4, $5, 'application/octet-stream', 3, $1, $6)`,
    [blobId, owner.connectorId, owner.instanceId, owner.stream, owner.key, Buffer.from([1, 2, 3])]
  );
  for (const b of bindings) {
    await sql.exec(
      `INSERT INTO blob_bindings(blob_id, connector_id, connector_instance_id, stream, record_key, json_path)
             VALUES($1, $2, $3, $4, $5, '@record')`,
      [blobId, b.connectorId, b.instanceId, b.stream, b.key]
    );
  }
}

const rec = (stream: string, key: string, subject: string, version = 1) => ({
  data: { id: key, subject: `${subject} v${version}` },
  emitted_at: NOW,
  key,
  stream,
});

/** Seed the connector, its two connections, records with history, blobs and lexical rows. */
export async function seedTeardownFixture(sql: Sql, ids: FixtureIds): Promise<void> {
  const {
    connector: CONNECTOR,
    sibling: SIBLING,
    instanceA: INSTANCE_A,
    instanceB: INSTANCE_B,
    instanceS: INSTANCE_S,
    blobs: BLOBS,
  } = ids;
  await registerConnector(manifestFor(CONNECTOR));
  await registerConnector(manifestFor(SIBLING));
  await insertInstance(sql, INSTANCE_A, CONNECTOR);
  await insertInstance(sql, INSTANCE_B, CONNECTOR);
  await insertInstance(sql, INSTANCE_S, SIBLING);
  const put = (connectorId: string, instanceId: string, r: ReturnType<typeof rec>) =>
    ingestRecord({ connector_id: connectorId, connector_instance_id: instanceId }, r, { deferIndexes: true });
  await put(CONNECTOR, INSTANCE_A, rec("items", "k1", "alpha"));
  await put(CONNECTOR, INSTANCE_A, rec("items", "k1", "alpha", 2));
  await put(CONNECTOR, INSTANCE_A, rec("items", "k2", "beta"));
  await put(CONNECTOR, INSTANCE_A, rec("notes", "n1", "gamma"));
  await put(CONNECTOR, INSTANCE_B, rec("items", "k3", "delta"));
  await put(CONNECTOR, INSTANCE_B, rec("items", "k4", "epsilon"));
  await put(CONNECTOR, INSTANCE_B, rec("notes", "n2", "zeta"));
  await put(SIBLING, INSTANCE_S, rec("items", "s1", "sibling"));
  const at = (connectorId: string, instanceId: string, stream: string, key: string): BlobSite => ({
    connectorId,
    instanceId,
    key,
    stream,
  });
  await insertBlob(sql, BLOBS.shared, at(CONNECTOR, INSTANCE_B, "items", "k3"), [
    at(CONNECTOR, INSTANCE_A, "items", "k1"),
    at(CONNECTOR, INSTANCE_B, "items", "k3"),
  ]);
  await insertBlob(sql, BLOBS.onlyA, at(CONNECTOR, INSTANCE_A, "notes", "n1"), [
    at(CONNECTOR, INSTANCE_A, "notes", "n1"),
  ]);
  await insertBlob(sql, BLOBS.onlyB, at(CONNECTOR, INSTANCE_B, "items", "k4"), [
    at(CONNECTOR, INSTANCE_B, "items", "k4"),
  ]);
  await insertBlob(sql, BLOBS.sibling, at(SIBLING, INSTANCE_S, "items", "s1"), [
    at(SIBLING, INSTANCE_S, "items", "s1"),
  ]);
  await lexicalIndexBackfillForManifest({
    manifest: manifestFor(CONNECTOR) as never,
  });
  await lexicalIndexBackfillForManifest({
    manifest: manifestFor(SIBLING) as never,
  });
}

export interface PairState {
  bindings: number;
  changes: number;
  counter: number;
  lexical: number;
  meta: number;
  records: number;
}
export interface TeardownState {
  blobs: Record<string, boolean>;
  pairs: Record<string, PairState>;
}

/** Row counts per (connection, stream) in every table the teardown touches, plus blob presence. */
export async function readTeardownState(sql: Sql, ids: FixtureIds): Promise<TeardownState> {
  const PAIRS: [string, string, string][] = [
    ["A", ids.instanceA, "items"],
    ["A", ids.instanceA, "notes"],
    ["B", ids.instanceB, "items"],
    ["B", ids.instanceB, "notes"],
    ["S", ids.instanceS, "items"],
  ];
  const count = async (table: string, instanceId: string, stream: string) =>
    Number(
      (
        await sql.rows(`SELECT COUNT(*) AS n FROM ${table} WHERE connector_instance_id = $1 AND stream = $2`, [
          instanceId,
          stream,
        ])
      )[0]?.n ?? 0
    );
  const pairs: Record<string, PairState> = {};
  for (const [role, instanceId, stream] of PAIRS) {
    pairs[`${role}/${stream}`] = {
      bindings: await count("blob_bindings", instanceId, stream),
      changes: await count("record_changes", instanceId, stream),
      counter: await count("version_counter", instanceId, stream),
      lexical: await count("lexical_search_index", instanceId, stream),
      meta: await count("lexical_search_meta", instanceId, stream),
      records: await count("records", instanceId, stream),
    };
  }
  const blobs: Record<string, boolean> = {};
  for (const [role, blobId] of Object.entries(ids.blobs)) {
    blobs[role] = (await sql.rows("SELECT 1 AS present FROM blobs WHERE blob_id = $1", [blobId])).length > 0;
  }
  return { blobs, pairs };
}
