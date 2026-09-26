// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/** The database pointer is the only authority for an OCI connector's runnable bytes. */
import { createHash, randomUUID } from "node:crypto";
import { normalizeConnectorManifestForStorage } from "../auth.ts";
import { getDb } from "../db.ts";
import { isPostgresStorageBackend, postgresQuery, withPostgresTransaction } from "../postgres-storage.ts";
import type { ConnectorInstallRecord } from "./index.ts";

export interface ConnectorActivation {
  readonly activationId: string;
  readonly attemptId: string;
  readonly canonicalManifest: Record<string, unknown>;
  readonly manifestRevision: string;
  readonly record: ConnectorInstallRecord;
  readonly repairError: string | null;
  readonly repairReason: string | null;
  readonly state: "active" | "repair_required";
}

interface ActivationRow {
  activation_id: string;
  attempt_id: string;
  canonical_manifest_json: string;
  manifest_revision: string;
  record_json: string;
  repair_error_json: string | null;
  repair_reason: string | null;
  state: "active" | "repair_required";
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, candidate) => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
      return candidate;
    }
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(candidate).sort()) {
      sorted[key] = candidate[key];
    }
    return sorted;
  });
}

function sha256(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

export function canonicalActivationManifestRevision(manifest: Record<string, unknown>): string {
  return sha256(canonicalJson(normalizeConnectorManifestForStorage(manifest).storedManifest));
}

function activationValues(record: ConnectorInstallRecord): {
  activationId: string;
  canonicalManifestJson: string;
  manifestRevision: string;
  recordJson: string;
} {
  const { connectorId, storedManifest } = normalizeConnectorManifestForStorage(record.manifest);
  if (connectorId !== record.connectorId) {
    throw new Error("Connector activation manifest identity mismatch");
  }
  const canonicalManifestJson = canonicalJson(storedManifest);
  const manifestRevision = sha256(canonicalManifestJson);
  const recordJson = JSON.stringify(record);
  const activationId = sha256(
    canonicalJson({
      configDigest: record.configDigest,
      digest: record.digest,
      entrypointPath: record.entrypointPath,
      entrypointSha256: record.entrypointSha256,
      manifestRevision,
      manifestSha256: record.manifestSha256,
      provenanceSha256: record.provenanceSha256,
      root: record.root,
    })
  );
  return { activationId, canonicalManifestJson, manifestRevision, recordJson };
}

function parseRow(row: ActivationRow | undefined): ConnectorActivation | null {
  if (!row) {
    return null;
  }
  const record = JSON.parse(row.record_json) as ConnectorInstallRecord;
  const canonicalManifest = JSON.parse(row.canonical_manifest_json) as Record<string, unknown>;
  const expected = activationValues(record);
  if (
    expected.activationId !== row.activation_id ||
    expected.manifestRevision !== row.manifest_revision ||
    expected.canonicalManifestJson !== canonicalJson(canonicalManifest)
  ) {
    throw new Error(`Connector activation authority is corrupt for ${record.connectorId}`);
  }
  return {
    activationId: row.activation_id,
    attemptId: row.attempt_id,
    canonicalManifest,
    manifestRevision: row.manifest_revision,
    record,
    repairError: row.repair_error_json,
    repairReason: row.repair_reason,
    state: row.state,
  };
}

/** Atomically publish the registry manifest, generation advance, and executable tuple. */
export async function publishConnectorActivation(record: ConnectorInstallRecord): Promise<ConnectorActivation> {
  const values = activationValues(record);
  const attemptId = randomUUID();
  const id = record.connectorId;
  if (isPostgresStorageBackend()) {
    await withPostgresTransaction(async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtext('connector_activation'), hashtext($1))", [id]);
      const changed = await client.query(
        `INSERT INTO connectors(connector_id, manifest) VALUES($1, $2::jsonb)
         ON CONFLICT(connector_id) DO UPDATE SET manifest = EXCLUDED.manifest
         WHERE connectors.manifest IS DISTINCT FROM EXCLUDED.manifest RETURNING connector_id`,
        [id, values.canonicalManifestJson]
      );
      if (changed.rowCount) {
        await client.query(
          "UPDATE connector_instances SET manifest_generation = manifest_generation + 1 WHERE connector_id = $1",
          [id]
        );
        await client.query("UPDATE connector_summary_evidence SET dirty = 1, state = 'stale' WHERE connector_id = $1", [
          id,
        ]);
      }
      await client.query(
        `INSERT INTO connector_activations(connector_id,state,record_json,canonical_manifest_json,manifest_revision,activation_id,attempt_id,repair_reason,updated_at)
         VALUES($1,'repair_required',$2,$3,$4,$5,$6,'Derived manifest repair pending',clock_timestamp()::text)
         ON CONFLICT(connector_id) DO UPDATE SET state='repair_required',record_json=EXCLUDED.record_json,
         canonical_manifest_json=EXCLUDED.canonical_manifest_json,manifest_revision=EXCLUDED.manifest_revision,
         activation_id=EXCLUDED.activation_id,attempt_id=EXCLUDED.attempt_id,
         repair_reason='Derived manifest repair pending',repair_error_json=NULL,updated_at=EXCLUDED.updated_at`,
        [id, values.recordJson, values.canonicalManifestJson, values.manifestRevision, values.activationId, attemptId]
      );
      await client.query(
        `INSERT INTO connector_installs(connector_id,record_json,updated_at) VALUES($1,$2,clock_timestamp()::text)
         ON CONFLICT(connector_id) DO UPDATE SET record_json=EXCLUDED.record_json,updated_at=EXCLUDED.updated_at`,
        [id, values.recordJson]
      );
    });
  } else {
    getDb()
      .transaction(() => {
        const db = getDb();
        const old = db.prepare("SELECT manifest FROM connectors WHERE connector_id = ?").get<{ manifest: string }>(id);
        if (!old || canonicalJson(JSON.parse(old.manifest)) !== values.canonicalManifestJson) {
          db.prepare(
            "INSERT INTO connectors(connector_id,manifest) VALUES(?,?) ON CONFLICT(connector_id) DO UPDATE SET manifest=excluded.manifest"
          ).run(id, values.canonicalManifestJson);
          db.prepare(
            "UPDATE connector_instances SET manifest_generation=manifest_generation+1 WHERE connector_id=?"
          ).run(id);
          db.prepare("UPDATE connector_summary_evidence SET dirty=1,state='stale' WHERE connector_id=?").run(id);
        }
        db.prepare(`INSERT INTO connector_activations(connector_id,state,record_json,canonical_manifest_json,manifest_revision,activation_id,attempt_id,repair_reason,updated_at)
        VALUES(?,'repair_required',?,?,?,?,?,'Derived manifest repair pending',datetime('now')) ON CONFLICT(connector_id) DO UPDATE SET
        state='repair_required',record_json=excluded.record_json,canonical_manifest_json=excluded.canonical_manifest_json,
        manifest_revision=excluded.manifest_revision,activation_id=excluded.activation_id,attempt_id=excluded.attempt_id,
        repair_reason='Derived manifest repair pending',repair_error_json=NULL,updated_at=excluded.updated_at`).run(
          id,
          values.recordJson,
          values.canonicalManifestJson,
          values.manifestRevision,
          values.activationId,
          attemptId
        );
        db.prepare(
          "INSERT INTO connector_installs(connector_id,record_json,updated_at) VALUES(?,?,datetime('now')) ON CONFLICT(connector_id) DO UPDATE SET record_json=excluded.record_json,updated_at=excluded.updated_at"
        ).run(id, values.recordJson);
      })
      .immediate();
  }
  return {
    activationId: values.activationId,
    attemptId,
    canonicalManifest: JSON.parse(values.canonicalManifestJson) as Record<string, unknown>,
    manifestRevision: values.manifestRevision,
    record,
    repairError: null,
    repairReason: "Derived manifest repair pending",
    state: "repair_required",
  };
}

/** A failed post-publication repair is durable and blocks every installed-code reader. */
export async function markConnectorActivationRepairRequired(
  connectorId: string,
  attemptId: string,
  reason: string,
  error: unknown
): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  if (isPostgresStorageBackend()) {
    const result = await postgresQuery(
      `UPDATE connector_activations SET state='repair_required',repair_reason=$3,repair_error_json=$4,
       updated_at=clock_timestamp()::text WHERE connector_id=$1 AND attempt_id=$2`,
      [connectorId, attemptId, reason, JSON.stringify({ message })]
    );
    if (!result.rowCount) {
      throw new Error("Connector activation changed before repair state could be recorded");
    }
  } else {
    const result = getDb()
      .prepare(`UPDATE connector_activations SET state='repair_required',repair_reason=?,repair_error_json=?,
      updated_at=datetime('now') WHERE connector_id=? AND attempt_id=?`)
      .run(reason, JSON.stringify({ message }), connectorId, attemptId);
    if (!result.changes) {
      throw new Error("Connector activation changed before repair state could be recorded");
    }
  }
}

export async function completeConnectorActivation(connectorId: string, attemptId: string): Promise<void> {
  if (isPostgresStorageBackend()) {
    await withPostgresTransaction(async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtext('connector_activation'), hashtext($1))", [connectorId]);
      const activation = await client.query<{
        canonical_manifest_json: string;
        manifest_revision: string;
      }>(
        "SELECT canonical_manifest_json,manifest_revision FROM connector_activations WHERE connector_id=$1 AND attempt_id=$2 AND state='repair_required' FOR UPDATE",
        [connectorId, attemptId]
      );
      if (!activation.rows[0]) {
        throw new Error("Connector activation changed before repair completed");
      }
      const registry = await client.query<{ manifest: unknown }>(
        "SELECT manifest FROM connectors WHERE connector_id=$1 FOR SHARE",
        [connectorId]
      );
      assertCompatibleRepairManifest(
        activation.rows[0].canonical_manifest_json,
        activation.rows[0].manifest_revision,
        registry.rows[0]?.manifest
      );
      await client.query(
        `UPDATE connector_activations SET state='active',repair_reason=NULL,repair_error_json=NULL,
       updated_at=clock_timestamp()::text WHERE connector_id=$1 AND attempt_id=$2`,
        [connectorId, attemptId]
      );
    });
  } else {
    getDb()
      .transaction(() => {
        const db = getDb();
        const activation = db
          .prepare(
            "SELECT canonical_manifest_json,manifest_revision FROM connector_activations WHERE connector_id=? AND attempt_id=? AND state='repair_required'"
          )
          .get<{ canonical_manifest_json: string; manifest_revision: string }>(connectorId, attemptId);
        if (!activation) {
          throw new Error("Connector activation changed before repair completed");
        }
        const registry = db
          .prepare("SELECT manifest FROM connectors WHERE connector_id=?")
          .get<{ manifest: string }>(connectorId);
        assertCompatibleRepairManifest(
          activation.canonical_manifest_json,
          activation.manifest_revision,
          registry?.manifest
        );
        db.prepare(`UPDATE connector_activations SET state='active',repair_reason=NULL,repair_error_json=NULL,
      updated_at=datetime('now') WHERE connector_id=? AND attempt_id=?`).run(connectorId, attemptId);
      })
      .immediate();
  }
}

function assertCompatibleRepairManifest(
  activationManifestJson: string,
  activationManifestRevision: string,
  registryManifest: unknown
): void {
  if (!registryManifest) {
    throw new Error("Registry manifest disappeared during activation repair");
  }
  const activation = JSON.parse(activationManifestJson) as {
    streams?: unknown;
  };
  const registry =
    typeof registryManifest === "string"
      ? (JSON.parse(registryManifest) as Record<string, unknown>)
      : (registryManifest as Record<string, unknown>);
  if (canonicalJson(activation.streams) !== canonicalJson(registry.streams)) {
    throw new Error("Registry stream shape changed during activation repair");
  }
  if (canonicalActivationManifestRevision(registry) !== activationManifestRevision) {
    throw new Error("Registry manifest revision changed during activation repair");
  }
}

/** Legacy installations are imported once. A registry mismatch enters repair rather than guessing policy. */
async function migrateLegacyActivation(connectorId: string): Promise<void> {
  if (isPostgresStorageBackend()) {
    await withPostgresTransaction(async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtext('connector_activation'), hashtext($1))", [connectorId]);
      const existing = await client.query("SELECT 1 FROM connector_activations WHERE connector_id=$1", [connectorId]);
      if (existing.rowCount) {
        return;
      }
      const legacy = await client.query<{ record_json: string }>(
        "SELECT record_json FROM connector_installs WHERE connector_id=$1",
        [connectorId]
      );
      if (!legacy.rows[0]) {
        return;
      }
      const record = JSON.parse(legacy.rows[0].record_json) as ConnectorInstallRecord;
      const values = activationValues(record);
      const registry = await client.query<{ manifest: unknown }>(
        "SELECT manifest FROM connectors WHERE connector_id=$1",
        [connectorId]
      );
      const coherent = registry.rows[0] && canonicalJson(registry.rows[0].manifest) === values.canonicalManifestJson;
      await client.query(
        `INSERT INTO connector_activations(connector_id,state,record_json,canonical_manifest_json,manifest_revision,activation_id,attempt_id,repair_reason,updated_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,clock_timestamp()::text)`,
        [
          connectorId,
          coherent ? "active" : "repair_required",
          values.recordJson,
          values.canonicalManifestJson,
          values.manifestRevision,
          values.activationId,
          randomUUID(),
          coherent ? null : "Legacy registry and installed artifact disagree",
        ]
      );
    });
  } else {
    getDb()
      .transaction(() => {
        const db = getDb();
        if (db.prepare("SELECT 1 FROM connector_activations WHERE connector_id=?").get(connectorId)) {
          return;
        }
        const legacy = db
          .prepare("SELECT record_json FROM connector_installs WHERE connector_id=?")
          .get<{ record_json: string }>(connectorId);
        if (!legacy) {
          return;
        }
        const record = JSON.parse(legacy.record_json) as ConnectorInstallRecord;
        const values = activationValues(record);
        const registry = db
          .prepare("SELECT manifest FROM connectors WHERE connector_id=?")
          .get<{ manifest: string }>(connectorId);
        const coherent = registry && canonicalJson(JSON.parse(registry.manifest)) === values.canonicalManifestJson;
        db.prepare(`INSERT INTO connector_activations(connector_id,state,record_json,canonical_manifest_json,manifest_revision,activation_id,attempt_id,repair_reason,updated_at)
        VALUES(?,?,?,?,?,?,?,?,datetime('now'))`).run(
          connectorId,
          coherent ? "active" : "repair_required",
          values.recordJson,
          values.canonicalManifestJson,
          values.manifestRevision,
          values.activationId,
          randomUUID(),
          coherent ? null : "Legacy registry and installed artifact disagree"
        );
      })
      .immediate();
  }
}

async function migrateListedLegacyActivations(): Promise<void> {
  const ids = isPostgresStorageBackend()
    ? (
        await postgresQuery<{ connector_id: string }>(
          "SELECT connector_id FROM connector_installs i WHERE NOT EXISTS (SELECT 1 FROM connector_activations a WHERE a.connector_id=i.connector_id) ORDER BY connector_id"
        )
      ).rows
    : getDb()
        .prepare(
          "SELECT connector_id FROM connector_installs i WHERE NOT EXISTS (SELECT 1 FROM connector_activations a WHERE a.connector_id=i.connector_id) ORDER BY connector_id"
        )
        .all<{ connector_id: string }>();
  for (const row of ids) {
    // Each import is independently serialized with a concurrent installer.
    // biome-ignore lint/performance/noAwaitInLoops: Migrations are intentionally serialized by connector id.
    await migrateLegacyActivation(row.connector_id);
  }
}

export async function getConnectorActivation(connectorId: string): Promise<ConnectorActivation | null> {
  await migrateLegacyActivation(connectorId);
  const row = isPostgresStorageBackend()
    ? (await postgresQuery<ActivationRow>("SELECT * FROM connector_activations WHERE connector_id=$1", [connectorId]))
        .rows[0]
    : getDb().prepare("SELECT * FROM connector_activations WHERE connector_id=?").get<ActivationRow>(connectorId);
  return parseRow(row);
}

export async function listRunnableConnectorActivations(): Promise<readonly ConnectorActivation[]> {
  await migrateListedLegacyActivations();
  const rows = isPostgresStorageBackend()
    ? (
        await postgresQuery<ActivationRow>(
          "SELECT * FROM connector_activations WHERE state='active' ORDER BY connector_id"
        )
      ).rows
    : getDb()
        .prepare("SELECT * FROM connector_activations WHERE state='active' ORDER BY connector_id")
        .all<ActivationRow>();
  return rows.flatMap((row) => {
    const activation = parseRow(row);
    return activation ? [activation] : [];
  });
}

export async function listRepairRequiredConnectorActivations(): Promise<readonly ConnectorActivation[]> {
  await migrateListedLegacyActivations();
  const rows = isPostgresStorageBackend()
    ? (
        await postgresQuery<ActivationRow>(
          "SELECT * FROM connector_activations WHERE state='repair_required' ORDER BY connector_id"
        )
      ).rows
    : getDb()
        .prepare("SELECT * FROM connector_activations WHERE state='repair_required' ORDER BY connector_id")
        .all<ActivationRow>();
  return rows.flatMap((row) => {
    const activation = parseRow(row);
    return activation ? [activation] : [];
  });
}
