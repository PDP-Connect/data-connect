// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * One-time data migration: rename the connector ids that older releases
 * spelled with underscores (`claude_code`) to their manifest keys
 * (`claude-code`) in every stored row.
 *
 * The four old -> new pairs live here and nowhere else. Nothing at runtime
 * reads them: identity resolution has no rename step, and an old id sent by a
 * stale client is an unknown connector like any other. The pairs are data for
 * this migration only, which is why this module, and no other, names them.
 */

import type { PoolClient } from "pg";
import { makeConnectorInstanceSourceBindingKey } from "./connector-instance-utils.ts";

const RENAMES: readonly (readonly [oldId: string, newId: string])[] = Object.freeze([
  ["apple_photos", "apple-photos"],
  ["claude_code", "claude-code"],
  ["google_messages", "google-messages"],
  ["google_takeout", "google-takeout"],
]);

/** Postgres migration receipt id. Versioned: a behavior change ships as a new id. */
export const CONNECTOR_ID_RENAME_MIGRATION_ID = "renamed_connector_ids_v2";

const ID_COLUMN_NAMES = ["connector_id", "connector_key"] as const;

/**
 * What a rename run did. `supersededRows` counts, per table, the rows under an
 * old id that were deleted because a row under the current id has the same
 * remaining primary key or marker key (see {@link dropSupersededRowsSql}).
 */
export interface ConnectorIdRenameResult {
  changedRows: number;
  supersededRows: Readonly<Record<string, number>>;
  /** Old unique tuples retained under distinct keys, without changing instance ids. */
  disambiguatedRows: Readonly<Record<string, number>>;
}

const NO_RENAME: ConnectorIdRenameResult = Object.freeze({
  changedRows: 0,
  supersededRows: Object.freeze({}),
  disambiguatedRows: Object.freeze({}),
});

/** One log line for a run that changed rows; null when it changed nothing. */
export function describeConnectorIdRename(result: ConnectorIdRenameResult): string | null {
  if (result.changedRows === 0) {
    return null;
  }
  const superseded = Object.entries(result.supersededRows)
    .map(([table, rows]) => `${table}: ${rows}`)
    .join(", ");
  const disambiguated = Object.entries(result.disambiguatedRows)
    .map(([table, rows]) => `${table}: ${rows}`)
    .join(", ");
  const summary = superseded
    ? `Renamed connector ids: ${result.changedRows} rows changed; old-id rows replaced by current-id rows with the same key were deleted (${superseded})`
    : `Renamed connector ids: ${result.changedRows} rows changed`;
  return disambiguated ? `${summary}; binding collisions disambiguated (${disambiguated})` : summary;
}

interface IdColumn {
  column: string;
  /** Primary-key columns of the table other than this one; null when this column is not part of the primary key. */
  otherKeyColumns: string[] | null;
  table: string;
}

const quote = (identifier: string): string => `"${identifier.replaceAll('"', '""')}"`;

/**
 * SQL that, for one id column, deletes rows under `old` that a row under `new`
 * already covers: same values in every other primary-key column.
 *
 * The current-id row wins; the rest of the row is not compared. This is a
 * precedence rule, not a measured order: releases wrote the old ids before
 * the current ids, so the current-id row is normally the later write, but a
 * restored or imported store can break that. The tables this applies to
 * hold connector metadata and bookkeeping, not owner records
 * (records are keyed by instance, stream and record key). Observation history
 * is handled separately: only byte-equivalent replays may be deleted. A test in
 * retired-connector-id-migration.test.ts lists them, so a new table keyed by
 * connector id fails it until its precedence is decided here. Each deletion
 * is counted in {@link ConnectorIdRenameResult.supersededRows} and logged.
 */
function dropSupersededRowsSql(c: IdColumn, placeholders: { old: string; new: string }): string | null {
  if (c.otherKeyColumns === null || c.table === "connector_observation_runs") {
    return null;
  }
  const t = quote(c.table);
  const col = quote(c.column);
  const sameKey = c.otherKeyColumns.map((k) => `n.${quote(k)} = ${t}.${quote(k)}`).join(" AND ") || "1 = 1";
  return `DELETE FROM ${t} WHERE ${col} = ${placeholders.old}
            AND EXISTS (SELECT 1 FROM ${t} n WHERE n.${col} = ${placeholders.new} AND ${sameKey})`;
}

/** Non-primary UNIQUE keys whose collision policy is explicit below. */
export const HANDLED_CONNECTOR_UNIQUE_KEYS = [
  "acquisition_batches:artifact_sha256,connector_id,owner_subject_id",
  "browser_surface_leases:,connector_id,profile_key",
  "connector_instance_tombstones:connector_id,owner_subject_id,source_binding_key,source_kind",
  "connector_instances:connector_id,owner_subject_id,source_binding_key,source_kind",
  "connector_observation_runs:connector_id,recorded_seq",
  "device_source_instances:connector_id,device_id,local_binding_id",
] as const;

const COLLISION_TABLES = [
  "device_enrollment_codes",
  "connector_instances",
  "device_source_instances",
  "connector_instance_tombstones",
  "connector_observation_runs",
  "acquisition_batches",
  "browser_surface_leases",
] as const;
type Row = Record<string, unknown>;
interface CollisionWrite {
  table: string;
  sql: string;
  params: unknown[];
  superseded?: boolean;
}

/** Plan before changing keys, so NULL pointers can still resolve by the original binding. */
function collisionWrites(
  data: Record<string, Row[]>,
  oldId: string,
  newId: string,
  postgres: boolean,
): CollisionWrite[] {
  const writes: CollisionWrite[] = [];
  const rows = (table: string) => data[table] ?? [];
  const old = (table: string) => rows(table).filter((row) => row.connector_id === oldId);
  const current = (table: string) => rows(table).filter((row) => row.connector_id === newId);
  const equal = (a: Row, b: Row, cols: string[]) => cols.every((col) => a[col] === b[col]);
  const update = (table: string, idColumn: string, row: Row, values: Row) => {
    const cols = Object.keys(values);
    writes.push({
      table,
      sql: `UPDATE ${quote(table)} SET ${cols.map((col) => `${quote(col)} = ?`).join(", ")} WHERE ${quote(idColumn)} = ?`,
      params: [...Object.values(values), row[idColumn]],
    });
    Object.assign(row, values);
  };
  const free = (base: string, occupied: (candidate: string) => boolean) => {
    let candidate = `${base}#renamed-from:${oldId}`;
    for (let n = 2; occupied(candidate); n++) candidate = `${base}#renamed-from:${oldId}:${n}`;
    return candidate;
  };
  const sources = rows("device_source_instances");
  const instances = rows("connector_instances");
  const owner = (source: Row) =>
    data.device_exporters?.find((device) => device.device_id === source.device_id)?.owner_subject_id;
  const sourceKey = (name: unknown) =>
    makeConnectorInstanceSourceBindingKey({ kind: "local_device", local_binding_name: name });
  const bindingJson = (instance: Row): Row =>
    typeof instance.source_binding_json === "string"
      ? JSON.parse(instance.source_binding_json)
      : (instance.source_binding_json as Row);
  const originalTombstones = old("connector_instance_tombstones").map(row => ({ ...row }));
  const originalCodes = old("device_enrollment_codes").map(row => ({ ...row }));
  const movedCodes = new Set<unknown>();
  const currentCodeHolds = (subject: unknown, binding: unknown) => current("device_enrollment_codes").some(code => code.owner_subject_id === subject && sourceKey(code.local_binding_id) === binding);
  // Reserve original and planned bindings together, including deleted bindings.
  // Device bindings use the same owner/hash namespace as local-device instances.
  const occupancyKey = (subject: unknown, kind: unknown, key: unknown) => JSON.stringify([subject, kind, key]);
  const occupied = new Set([
    ...instances, ...rows("connector_instance_tombstones"),
    ...sources.map(source => ({ owner_subject_id: owner(source), source_kind: "local_device", source_binding_key: sourceKey(source.local_binding_id) })),
    ...rows("device_enrollment_codes").map(code => ({ owner_subject_id: code.owner_subject_id, source_kind: "local_device", source_binding_key: sourceKey(code.local_binding_id) })),
  ].map(row => occupancyKey(row.owner_subject_id, row.source_kind, row.source_binding_key)));
  const reserveName = (base: string, subject: unknown, kind: unknown) => {
    const key = (candidate: string) => occupancyKey(subject, kind, kind === "local_device" ? sourceKey(candidate) : candidate);
    const name = free(base, candidate => occupied.has(key(candidate)));
    occupied.add(key(name));
    return name;
  };
  const moveTombstones = (subject: unknown, from: unknown, to: string) => {
    for (const tombstone of originalTombstones) {
      if (tombstone.owner_subject_id === subject && tombstone.source_kind === "local_device" &&
          tombstone.source_binding_key === from) {
        const row = rows("connector_instance_tombstones").find(row => row.connector_instance_id === tombstone.connector_instance_id)!;
        update("connector_instance_tombstones", "connector_instance_id", row, { source_binding_key: to });
      }
    }
  };
  const moveCodes = (subject: unknown, from: unknown, to: string) => {
    for (const code of originalCodes) {
      if (code.owner_subject_id !== subject || sourceKey(code.local_binding_id) !== from) continue;
      const row = rows("device_enrollment_codes").find(row => row.enrollment_code_id === code.enrollment_code_id)!;
      update("device_enrollment_codes", "enrollment_code_id", row, { local_binding_id: to });
      movedCodes.add(code.enrollment_code_id);
    }
  };
  // Recover an absent pointer while the old connector and binding still identify its instance.
  for (const source of old("device_source_instances")) {
    if (source.connector_instance_id) continue;
    const instance = old("connector_instances").find(
      (instance) =>
        instance.owner_subject_id === owner(source) &&
        instance.source_kind === "local_device" &&
        instance.source_binding_key === sourceKey(source.local_binding_id),
    );
    if (instance)
      update("device_source_instances", "source_instance_id", source, {
        connector_instance_id: instance.connector_instance_id,
      });
  }
  for (const instance of old("connector_instances")) {
    const associated = sources.filter(
      (source) =>
        source.connector_instance_id === instance.connector_instance_id && source.connector_id === oldId,
    );
    // A current-spelling tombstone holds the key too: the owner deleted that
    // binding, so the live old connection must not take it over.
    const bindingCollision = (instance.source_kind === "local_device" && currentCodeHolds(instance.owner_subject_id, instance.source_binding_key)) || [...current("connector_instances"), ...current("connector_instance_tombstones")].some((n) =>
      equal(n, instance, ["owner_subject_id", "source_kind", "source_binding_key"]),
    );
    const deviceCollision = associated.some((source) =>
      current("device_source_instances").some((n) => equal(n, source, ["device_id", "local_binding_id"])),
    );
    if (!bindingCollision && !deviceCollision) continue;
    const local = instance.source_kind === "local_device";
    const binding = bindingJson(instance);
    const base = String(associated[0]?.local_binding_id ?? binding?.local_binding_name ?? instance.source_binding_key);
    const name = reserveName(base, instance.owner_subject_id, instance.source_kind);
    // The name suffix lives in local_binding_id; the instance stores its canonical hash.
    // Set both here, since Postgres may have already completed its canonicalization receipt.
    if (local) {
      moveCodes(instance.owner_subject_id, instance.source_binding_key, name);
      moveTombstones(instance.owner_subject_id, instance.source_binding_key, sourceKey(name));
    }
    update("connector_instances", "connector_instance_id", instance, {
      source_binding_key: local ? sourceKey(name) : name,
      ...(local ? { source_binding_json: JSON.stringify({ ...binding, kind: "local_device", local_binding_name: name }) } : {}),
    });
    for (const source of associated)
      update("device_source_instances", "source_instance_id", source, { local_binding_id: name });
  }
  for (const source of old("device_source_instances")) {
    const tombstoned = !source.connector_instance_id && originalTombstones.some(n => n.owner_subject_id === owner(source) && n.source_kind === "local_device" && n.source_binding_key === sourceKey(source.local_binding_id));
    const deletedBindingCollision = tombstoned &&
      (currentCodeHolds(owner(source), sourceKey(source.local_binding_id)) || current("connector_instances").some(n => n.owner_subject_id === owner(source) && n.source_kind === "local_device" && n.source_binding_key === sourceKey(source.local_binding_id)));
    if (!deletedBindingCollision && !current("device_source_instances").some((n) => equal(n, source, ["device_id", "local_binding_id"])))
      continue;
    const name = reserveName(String(source.local_binding_id), owner(source), "local_device");
    const associated = tombstoned ? old("device_source_instances").filter(n => !n.connector_instance_id && owner(n) === owner(source) && n.local_binding_id === source.local_binding_id) : [source];
    moveTombstones(owner(source), sourceKey(source.local_binding_id), sourceKey(name));
    moveCodes(owner(source), sourceKey(source.local_binding_id), name);
    for (const deleted of associated)
      update("device_source_instances", "source_instance_id", deleted, { local_binding_id: name });
  }
  // An owner deletion can outlive its source row. Keep that historical marker
  // distinct from a live current binding even when there is no source to remap.
  for (const tombstone of old("connector_instance_tombstones")) {
    const live = current("connector_instances").find((n) =>
      equal(n, tombstone, ["owner_subject_id", "source_kind", "source_binding_key"]));
    const code = current("device_enrollment_codes").find(code => code.owner_subject_id === tombstone.owner_subject_id && sourceKey(code.local_binding_id) === tombstone.source_binding_key);
    if (tombstone.source_kind !== "local_device" || (!live && !code)) continue;
    const binding = live ? bindingJson(live) : { local_binding_name: code!.local_binding_id };
    if (typeof binding?.local_binding_name !== "string") continue;
    const name = reserveName(binding.local_binding_name, tombstone.owner_subject_id, "local_device");
    moveCodes(tombstone.owner_subject_id, tombstone.source_binding_key, name);
    update("connector_instance_tombstones", "connector_instance_id", tombstone, { source_binding_key: sourceKey(name) });
  }
  // A code can precede the first source/instance. Preserve that unclaimed
  // old-id intent when the current spelling already owns its name.
  for (const code of originalCodes) {
    if (movedCodes.has(code.enrollment_code_id)) continue;
    const binding = sourceKey(code.local_binding_id);
    if (!currentCodeHolds(code.owner_subject_id, binding) &&
        ![...current("connector_instances"), ...current("connector_instance_tombstones")].some(row => row.owner_subject_id === code.owner_subject_id && row.source_kind === "local_device" && row.source_binding_key === binding)) continue;
    moveCodes(code.owner_subject_id, binding, reserveName(String(code.local_binding_id), code.owner_subject_id, "local_device"));
  }
  for (const table of ["connector_instance_tombstones", "browser_surface_leases"]) {
    for (const row of old(table)) {
      const pending = (r: Row) =>
        ["waiting_for_browser_surface", "starting_surface"].includes(String(r.status));
      const collision = current(table).some((n) =>
        table === "connector_instance_tombstones"
          ? equal(n, row, ["owner_subject_id", "source_kind", "source_binding_key"])
          : pending(row) &&
            pending(n) &&
            n.profile_key === row.profile_key &&
            (n.account_key ?? "") === (row.account_key ?? "") &&
            (!postgres || (n.surface_subject_id ?? "") === (row.surface_subject_id ?? "")),
      );
      if (!collision) continue;
      const id = table === "connector_instance_tombstones" ? "connector_instance_id" : "lease_id";
      // Tombstones block the same owner/binding under either spelling; pending leases are ephemeral.
      writes.push({
        table,
        sql: `DELETE FROM ${quote(table)} WHERE ${quote(id)} = ?`,
        params: [row[id]],
        superseded: true,
      });
    }
  }
  const runs = old("connector_observation_runs").sort(
    (a, b) => Number(a.recorded_seq) - Number(b.recorded_seq),
  );
  const newRuns = current("connector_observation_runs");
  for (const row of runs) {
    const replay = newRuns.find((n) => equal(n, row, ["connector_instance_id", "run_id", "record_version", "recorded_at", "payload_json"]));
    if (replay) writes.push({
      table: "connector_observation_runs",
      sql: "DELETE FROM connector_observation_runs WHERE connector_id = ? AND connector_instance_id = ? AND run_id = ?",
      params: [oldId, row.connector_instance_id, row.run_id],
      superseded: true,
    });
  }
  if (runs.some((row) => newRuns.some((n) => n.recorded_seq === row.recorded_seq))) {
    const min = Math.min(...rows("connector_observation_runs").map((row) => Number(row.recorded_seq)));
    // Sequences have no external references. Keep each history's order, with retired history
    // before current history: timestamps cannot establish a shared store write order.
    for (let i = 0; i < runs.length; i++) {
      const row = runs[i]!;
      writes.push({
        table: "connector_observation_runs",
        sql: "UPDATE connector_observation_runs SET recorded_seq = ? WHERE connector_id = ? AND connector_instance_id = ? AND run_id = ?",
        params: [min - runs.length + i, oldId, row.connector_instance_id, row.run_id],
      });
    }
  }
  for (const row of old("acquisition_batches")) {
    const winner = current("acquisition_batches").find(
      (n) =>
        row.artifact_sha256 != null &&
        row.superseded_by_batch_id == null &&
        n.superseded_by_batch_id == null &&
        equal(n, row, ["owner_subject_id", "artifact_sha256"]),
    );
    // Preserve digests, receipts and batch-id references; only the live dedup target changes.
    if (winner) update("acquisition_batches", "batch_id", row, { superseded_by_batch_id: winner.batch_id });
  }
  return writes;
}

function migrationTableError(table: string, cause: unknown): Error {
  return new Error(
    `Migration ${CONNECTOR_ID_RENAME_MIGRATION_ID} failed in table ${table}: ${cause instanceof Error ? cause.message : String(cause)}`,
    { cause }
  );
}

const renameEntries = (): [string, string][] => RENAMES.map(([oldId, newId]) => [oldId, newId]);

/**
 * Rows written before connection ids exist under `local-device:<connector>:<source>`.
 * The local-device sweep that recovers them runs after this rename and builds that
 * id from the source's current connector id, so those ids are renamed with their source.
 */
function legacyLocalDeviceEntries(sources: readonly Row[]): [string, string][] {
  const legacyId = (connectorId: string, source: Row) =>
    `local-device:${encodeURIComponent(connectorId)}:${encodeURIComponent(String(source.source_instance_id))}`;
  return renameEntries().flatMap(([oldId, newId]) =>
    sources.filter((source) => source.connector_id === oldId).map((source): [string, string] => [legacyId(oldId, source), legacyId(newId, source)]),
  );
}

const sqlLiteral = (value: string): string => `'${value.replaceAll("'", "''")}'`;

/** `CASE <col> WHEN old THEN new ... END` over every renamed id, so each table is updated in one scan. */
function renameCaseSql(column: string, placeholder: (n: number) => string, entries: readonly [string, string][]): { params: string[]; sql: string } {
  const params = entries.flatMap(([oldId, newId]) => [oldId, newId]);
  const whens = entries.map((_, i) => `WHEN ${placeholder(2 * i + 1)} THEN ${placeholder(2 * i + 2)}`).join(" ");
  return { params, sql: `CASE ${quote(column)} ${whens} ELSE ${quote(column)} END` };
}

/** Conflicting observations keep their original connector/instance/run provenance. */
function observationRenameGuard(c: IdColumn, entries: readonly [string, string][]): string {
  if (c.table !== "connector_observation_runs") return "";
  return ` AND NOT EXISTS (SELECT 1 FROM connector_observation_runs n
    WHERE n.connector_id = CASE connector_observation_runs.connector_id ${entries.map(([oldId, newId]) => `WHEN ${sqlLiteral(oldId)} THEN ${sqlLiteral(newId)}`).join(" ")} END
      AND n.connector_instance_id = connector_observation_runs.connector_instance_id
      AND n.run_id = connector_observation_runs.run_id)`;
}

/** Placeholders for the old ids, numbered after `offset` earlier parameters. */
function renamedInList(placeholder: (n: number) => string, entries: readonly [string, string][], offset = 0): string {
  return entries
    .map((_, i) => placeholder(offset + i + 1))
    .join(", ");
}

/**
 * Replace the id fields inside a stored manifest document: every field `canonicalConnectorKeyFromManifest`
 * reads, the top-level ones and `storage_binding.connector_id`. Unparseable text is returned unchanged.
 */
function rewriteManifestIds(manifest: unknown, oldId: string, newId: string): unknown {
  let parsed: unknown = manifest;
  if (typeof manifest === "string") {
    try {
      parsed = JSON.parse(manifest);
    } catch {
      return manifest;
    }
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return manifest;
  }
  const record: Record<string, unknown> = { ...parsed };
  for (const field of ID_COLUMN_NAMES) {
    if (record[field] === oldId) {
      record[field] = newId;
    }
  }
  const binding = record.storage_binding;
  if (binding !== null && typeof binding === "object" && !Array.isArray(binding)) {
    const bindingRecord = binding as Record<string, unknown>;
    if (bindingRecord.connector_id === oldId) {
      record.storage_binding = { ...bindingRecord, connector_id: newId };
    }
  }
  // SQLite stores the manifest as text, Postgres as jsonb (the driver hands back an object).
  return typeof manifest === "string" ? JSON.stringify(record) : record;
}

// ---------------------------------------------------------------- SQLite

interface SqliteStatementLike {
  all: (...params: unknown[]) => Record<string, unknown>[];
  get: (...params: unknown[]) => Record<string, unknown> | undefined;
  run: (...params: unknown[]) => unknown;
}

export interface SqliteLike {
  exec: (source: string) => unknown;
  prepare: (sql: string) => SqliteStatementLike;
  transaction: <T>(fn: () => T) => (() => T) & { immediate: () => T };
}

function sqliteIdColumns(raw: SqliteLike): IdColumn[] {
  const tables = raw
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all();
  const found: IdColumn[] = [];
  for (const { name } of tables) {
    const table = String(name);
    const columns = raw.prepare(`PRAGMA table_info(${quote(table)})`).all();
    const keyColumns = columns.filter((c) => Number(c.pk) > 0).map((c) => String(c.name));
    for (const c of columns) {
      const column = String(c.name);
      if ((ID_COLUMN_NAMES as readonly string[]).includes(column)) {
        found.push({
          column,
          otherKeyColumns: keyColumns.includes(column) ? keyColumns.filter((k) => k !== column) : null,
          table,
        });
      }
    }
  }
  return found;
}

/**
 * Rename stored old connector ids to their current keys in one transaction.
 * Changes nothing, and writes nothing, when no old id is stored.
 *
 * Order respects the foreign keys to `connectors(connector_id)`: the current
 * key's `connectors` row is created first, every referencing row is moved,
 * and the old row is deleted last. A row keyed by the old id that a
 * row keyed by the current id already covers is deleted (the current row
 * wins; see {@link dropSupersededRowsSql}). Known unique-key collisions retain
 * history under distinct keys or drop superseded markers. Any unhandled constraint
 * aborts with the migration id and table rather than deleting owner data.
 */
export function migrateRenamedConnectorIdsSqlite(raw: SqliteLike): ConnectorIdRenameResult {
  const columns = sqliteIdColumns(raw);
  const olds = renameEntries().map(([oldId]) => oldId);
  const marks = renamedInList(() => "?", renameEntries());
  const anyStored = columns.some(
    (c) =>
      raw.prepare(`SELECT 1 FROM ${quote(c.table)} WHERE ${quote(c.column)} IN (${marks}) LIMIT 1`).get(...olds) !==
      undefined
  );
  if (!anyStored) {
    return NO_RENAME;
  }
  const run = raw.transaction((): ConnectorIdRenameResult => {
    let changed = 0;
    const superseded: Record<string, number> = {};
    const disambiguated: Record<string, number> = {};
    const supersededParents = new Set<string>();
    const legacy = legacyLocalDeviceEntries(raw.prepare("SELECT * FROM device_source_instances").all());
    const entries = [...renameEntries(), ...legacy];
    const allOlds = entries.map(([oldId]) => oldId);
    for (const [oldId, newId] of renameEntries()) {
      if (adoptParentSqlite(raw, oldId, newId) === "superseded") {
        supersededParents.add(oldId);
      }
      const data: Record<string, Row[]> = {};
      for (const table of [...COLLISION_TABLES, "device_exporters"]) {
        if (columns.some(c => c.table === table) || table === "device_exporters") {
          data[table] = raw.prepare(`SELECT * FROM ${quote(table)}`).all();
        }
      }
      for (const write of collisionWrites(data, oldId, newId, false)) {
        try {
          countSuperseded(write.superseded ? superseded : disambiguated, write.table, sqliteChanges(raw.prepare(write.sql).run(...write.params)));
        } catch (err) { throw migrationTableError(write.table, err); }
      }
      for (const c of columns.filter((x) => x.table !== "connectors")) {
        const drop = dropSupersededRowsSql(c, { new: "?", old: "?" });
        if (drop) {
          countSuperseded(superseded, c.table, sqliteChanges(raw.prepare(drop).run(oldId, newId)));
        }
      }
    }
    // Legacy ids hold no bindings, so they need only the parent row and key cleanup.
    for (const [oldId, newId] of legacy) {
      if (adoptParentSqlite(raw, oldId, newId) === "superseded") supersededParents.add(oldId);
      for (const c of columns.filter((x) => x.table !== "connectors")) {
        const drop = dropSupersededRowsSql(c, { new: "?", old: "?" });
        if (drop) countSuperseded(superseded, c.table, sqliteChanges(raw.prepare(drop).run(oldId, newId)));
      }
    }
    for (const c of columns.filter((x) => x.table !== "connectors")) {
      const rename = renameCaseSql(c.column, () => "?", entries);
      try {
        changed += sqliteChanges(
          raw
            .prepare(
              `UPDATE ${quote(c.table)} SET ${quote(c.column)} = ${rename.sql} WHERE ${quote(c.column)} IN (${renamedInList(() => "?", entries)})${observationRenameGuard(c, entries)}`
            )
            .run(...rename.params, ...allOlds)
        );
      } catch (err) {
        throw migrationTableError(c.table, err);
      }
    }
    // Old parents go last, once no child names them. One the current row
    // already covered is a superseded row, like the children above.
    const oldParents = partitionOldParents(allOlds, supersededParents);
    countSuperseded(superseded, "connectors", deleteConnectorsSqlite(raw, oldParents.superseded));
    changed += deleteConnectorsSqlite(raw, oldParents.copied);
    // A connection created without a name is labelled with its connector id.
    // Keep that placeholder in step with the id it names; a connection of
    // another connector that happens to carry the same text keeps it.
    for (const [oldId, newId] of renameEntries()) {
      changed += sqliteChanges(raw.prepare(renamePlaceholderLabelSql(() => "?")).run(newId, oldId, newId));
    }
    return {
      changedRows: changed + sumSuperseded(superseded),
      supersededRows: superseded,
      disambiguatedRows: disambiguated,
    };
  });
  return run.immediate();
}

const sqliteChanges = (result: unknown): number => Number((result as { changes?: number }).changes ?? 0);

/**
 * What happens to an old id's `connectors` row: it is copied to the current
 * id, or the current id already has one and the old row is superseded.
 */
type ParentOutcome = "absent" | "copied" | "superseded";

function connectorCopy(parent: Record<string, unknown>, oldId: string, newId: string): Record<string, unknown> {
  return { ...parent, connector_id: newId, manifest: rewriteManifestIds(parent.manifest, oldId, newId) };
}

function adoptParentSqlite(raw: SqliteLike, oldId: string, newId: string): ParentOutcome {
  const parent = raw.prepare("SELECT * FROM connectors WHERE connector_id = ?").get(oldId) as
    | Record<string, unknown>
    | undefined;
  if (!parent) {
    return "absent";
  }
  if (raw.prepare("SELECT 1 FROM connectors WHERE connector_id = ?").get(newId) !== undefined) {
    return "superseded";
  }
  const copy = connectorCopy(parent, oldId, newId);
  const names = Object.keys(copy);
  raw
    .prepare(`INSERT INTO connectors (${names.map(quote).join(", ")}) VALUES (${names.map(() => "?").join(", ")})`)
    .run(...names.map((n) => copy[n]));
  return "copied";
}

function deleteConnectorsSqlite(raw: SqliteLike, ids: readonly string[]): number {
  if (ids.length === 0) {
    return 0;
  }
  return sqliteChanges(
    raw.prepare(`DELETE FROM connectors WHERE connector_id IN (${ids.map(() => "?").join(", ")})`).run(...ids)
  );
}

/** Split the old ids into parents the current row covered and the rest. */
function partitionOldParents(
  olds: readonly string[],
  supersededParents: ReadonlySet<string>
): { copied: string[]; superseded: string[] } {
  return {
    copied: olds.filter((id) => !supersededParents.has(id)),
    superseded: olds.filter((id) => supersededParents.has(id)),
  };
}

/** Parameters: the current id, the old id, the current id. */
const renamePlaceholderLabelSql = (placeholder: (n: number) => string): string =>
  `UPDATE connector_instances SET display_name = ${placeholder(1)}
    WHERE display_name = ${placeholder(2)} AND connector_id = ${placeholder(3)}`;

function countSuperseded(into: Record<string, number>, table: string, rows: number): void {
  if (rows > 0) {
    into[table] = (into[table] ?? 0) + rows;
  }
}

const sumSuperseded = (superseded: Readonly<Record<string, number>>): number =>
  Object.values(superseded).reduce((sum, rows) => sum + rows, 0);

// ---------------------------------------------------------------- Postgres

async function postgresIdColumns(client: PoolClient): Promise<IdColumn[]> {
  const result = await client.query<{ column_name: string; table_name: string }>(
    `SELECT c.table_name, c.column_name
       FROM information_schema.columns c
       JOIN information_schema.tables t
         ON t.table_schema = c.table_schema AND t.table_name = c.table_name AND t.table_type = 'BASE TABLE'
      WHERE c.table_schema = current_schema() AND c.column_name = ANY($1::text[])
      ORDER BY c.table_name, c.column_name`,
    [[...ID_COLUMN_NAMES]]
  );
  const found: IdColumn[] = [];
  for (const row of result.rows) {
    const keys = await client.query<{ attname: string }>(
      `SELECT a.attname
         FROM pg_index i
         JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY (i.indkey)
        WHERE i.indrelid = $1::regclass AND i.indisprimary`,
      [quote(row.table_name)]
    );
    const keyColumns = keys.rows.map((k) => k.attname);
    found.push({
      column: row.column_name,
      otherKeyColumns: keyColumns.includes(row.column_name) ? keyColumns.filter((k) => k !== row.column_name) : null,
      table: row.table_name,
    });
  }
  return found;
}

/**
 * Postgres counterpart of {@link migrateRenamedConnectorIdsSqlite}. The caller
 * owns the migration receipt; this function runs the rename in one transaction
 * (no write when no old id is stored).
 */
export async function migrateRenamedConnectorIdsPostgres(client: PoolClient): Promise<ConnectorIdRenameResult> {
  const columns = await postgresIdColumns(client);
  const olds = renameEntries().map(([oldId]) => oldId);
  const marks = renamedInList((n) => `$${n}`, renameEntries());
  let anyStored = false;
  for (const c of columns) {
    const hit = await client.query(`SELECT 1 FROM ${quote(c.table)} WHERE ${quote(c.column)} IN (${marks}) LIMIT 1`, olds);
    if (hit.rowCount) {
      anyStored = true;
      break;
    }
  }
  if (!anyStored) {
    return NO_RENAME;
  }
  await client.query("BEGIN");
  try {
    let changed = 0;
    const superseded: Record<string, number> = {};
    const disambiguated: Record<string, number> = {};
    const supersededParents = new Set<string>();
    const legacy = legacyLocalDeviceEntries((await client.query("SELECT * FROM device_source_instances")).rows);
    const entries = [...renameEntries(), ...legacy];
    const allOlds = entries.map(([oldId]) => oldId);
    for (const [oldId, newId] of renameEntries()) {
      if ((await adoptParentPostgres(client, oldId, newId)) === "superseded") {
        supersededParents.add(oldId);
      }
      const data: Record<string, Row[]> = {};
      for (const table of [...COLLISION_TABLES, "device_exporters"]) {
        if (columns.some(c => c.table === table) || table === "device_exporters") {
          data[table] = (await client.query(`SELECT * FROM ${quote(table)}`)).rows;
        }
      }
      for (const write of collisionWrites(data, oldId, newId, true)) {
        try {
          let param = 0;
          const sql = write.sql.replaceAll("?", () => `$${++param}`);
          countSuperseded(write.superseded ? superseded : disambiguated, write.table, (await client.query(sql, write.params)).rowCount ?? 0);
        } catch (err) { throw migrationTableError(write.table, err); }
      }
      for (const c of columns.filter((x) => x.table !== "connectors")) {
        const drop = dropSupersededRowsSql(c, { new: "$2", old: "$1" });
        if (drop) {
          countSuperseded(superseded, c.table, (await client.query(drop, [oldId, newId])).rowCount ?? 0);
        }
      }
    }
    // Legacy ids hold no bindings, so they need only the parent row and key cleanup.
    for (const [oldId, newId] of legacy) {
      if ((await adoptParentPostgres(client, oldId, newId)) === "superseded") supersededParents.add(oldId);
      for (const c of columns.filter((x) => x.table !== "connectors")) {
        const drop = dropSupersededRowsSql(c, { new: "$2", old: "$1" });
        if (drop) countSuperseded(superseded, c.table, (await client.query(drop, [oldId, newId])).rowCount ?? 0);
      }
    }
    for (const c of columns.filter((x) => x.table !== "connectors")) {
      const rename = renameCaseSql(c.column, (n) => `$${n}`, entries);
      try {
        const result = await client.query(
          `UPDATE ${quote(c.table)} SET ${quote(c.column)} = ${rename.sql}
          WHERE ${quote(c.column)} IN (${renamedInList((n) => `$${n}`, entries, rename.params.length)})${observationRenameGuard(c, entries)}`,
          [...rename.params, ...allOlds]
        );
        changed += result.rowCount ?? 0;
      } catch (err) {
        throw migrationTableError(c.table, err);
      }
    }
    // Old parents go last, once no child names them. One the current row
    // already covered is a superseded row, like the children above.
    const oldParents = partitionOldParents(allOlds, supersededParents);
    countSuperseded(superseded, "connectors", await deleteConnectorsPostgres(client, oldParents.superseded));
    changed += await deleteConnectorsPostgres(client, oldParents.copied);
    // A connection created without a name is labelled with its connector id.
    // Keep that placeholder in step with the id it names; a connection of
    // another connector that happens to carry the same text keeps it.
    for (const [oldId, newId] of renameEntries()) {
      const labels = await client.query(renamePlaceholderLabelSql((n) => `$${n}`), [newId, oldId, newId]);
      changed += labels.rowCount ?? 0;
    }
    await client.query("COMMIT");
    return {
      changedRows: changed + sumSuperseded(superseded),
      supersededRows: superseded,
      disambiguatedRows: disambiguated,
    };
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // Keep the original error.
    }
    throw err;
  }
}

async function adoptParentPostgres(client: PoolClient, oldId: string, newId: string): Promise<ParentOutcome> {
  const parent = (await client.query("SELECT * FROM connectors WHERE connector_id = $1", [oldId])).rows[0] as
    | Record<string, unknown>
    | undefined;
  if (!parent) {
    return "absent";
  }
  if ((await client.query("SELECT 1 FROM connectors WHERE connector_id = $1", [newId])).rowCount !== 0) {
    return "superseded";
  }
  const copy = connectorCopy(parent, oldId, newId);
  const names = Object.keys(copy);
  await client.query(
    `INSERT INTO connectors (${names.map(quote).join(", ")}) VALUES (${names.map((_, i) => `$${i + 1}`).join(", ")})`,
    names.map((n) => copy[n])
  );
  return "copied";
}

async function deleteConnectorsPostgres(client: PoolClient, ids: readonly string[]): Promise<number> {
  if (ids.length === 0) {
    return 0;
  }
  return (await client.query("DELETE FROM connectors WHERE connector_id = ANY($1::text[])", [ids])).rowCount ?? 0;
}
