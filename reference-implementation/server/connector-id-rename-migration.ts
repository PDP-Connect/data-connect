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

const RENAMES: readonly (readonly [oldId: string, newId: string])[] = Object.freeze([
  ["apple_photos", "apple-photos"],
  ["claude_code", "claude-code"],
  ["google_messages", "google-messages"],
  ["google_takeout", "google-takeout"],
]);

/** Postgres migration receipt id. Versioned: a behavior change ships as a new id. */
export const CONNECTOR_ID_RENAME_MIGRATION_ID = "renamed_connector_ids_v1";

const ID_COLUMN_NAMES = ["connector_id", "connector_key"] as const;

/**
 * What a rename run did. `supersededRows` counts, per table, the rows under an
 * old id that were deleted because a row under the current id has the same
 * remaining primary key (see {@link dropSupersededRowsSql}).
 */
export interface ConnectorIdRenameResult {
  changedRows: number;
  supersededRows: Readonly<Record<string, number>>;
}

const NO_RENAME: ConnectorIdRenameResult = Object.freeze({ changedRows: 0, supersededRows: Object.freeze({}) });

/** One log line for a run that changed rows; null when it changed nothing. */
export function describeConnectorIdRename(result: ConnectorIdRenameResult): string | null {
  if (result.changedRows === 0) {
    return null;
  }
  const superseded = Object.entries(result.supersededRows)
    .map(([table, rows]) => `${table}: ${rows}`)
    .join(", ");
  return superseded
    ? `Renamed connector ids: ${result.changedRows} rows changed; old-id rows replaced by current-id rows with the same key were deleted (${superseded})`
    : `Renamed connector ids: ${result.changedRows} rows changed`;
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
 * Precedence is the same for every table and does not compare the rest of
 * the row: the current-id row wins. Releases wrote the old ids before they
 * wrote the current ids, never after, so when both rows exist the current-id
 * row is the later write and the old-id row is stale. Each deletion is
 * counted in {@link ConnectorIdRenameResult.supersededRows} and logged.
 */
function dropSupersededRowsSql(c: IdColumn, placeholders: { old: string; new: string }): string | null {
  if (c.otherKeyColumns === null) {
    return null;
  }
  const t = quote(c.table);
  const col = quote(c.column);
  const sameKey = c.otherKeyColumns.map((k) => `n.${quote(k)} = ${t}.${quote(k)}`).join(" AND ") || "1 = 1";
  return `DELETE FROM ${t} WHERE ${col} = ${placeholders.old}
            AND EXISTS (SELECT 1 FROM ${t} n WHERE n.${col} = ${placeholders.new} AND ${sameKey})`;
}

const renameEntries = (): [string, string][] => RENAMES.map(([oldId, newId]) => [oldId, newId]);

/** `CASE <col> WHEN old THEN new ... END` over every renamed id, so each table is updated in one scan. */
function renameCaseSql(column: string, placeholder: (n: number) => string): { params: string[]; sql: string } {
  const entries = renameEntries();
  const params = entries.flatMap(([oldId, newId]) => [oldId, newId]);
  const whens = entries.map((_, i) => `WHEN ${placeholder(2 * i + 1)} THEN ${placeholder(2 * i + 2)}`).join(" ");
  return { params, sql: `CASE ${quote(column)} ${whens} ELSE ${quote(column)} END` };
}

/** Placeholders for the old ids, numbered after `offset` earlier parameters. */
function renamedInList(placeholder: (n: number) => string, offset = 0): string {
  return renameEntries()
    .map((_, i) => placeholder(offset + i + 1))
    .join(", ");
}

/** Replace the id fields inside a stored manifest document. Unparseable text is returned unchanged. */
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
 * wins; see {@link dropSupersededRowsSql}); any other unique-key collision
 * aborts the migration with the database's error rather than merging data.
 */
export function migrateRenamedConnectorIdsSqlite(raw: SqliteLike): ConnectorIdRenameResult {
  const columns = sqliteIdColumns(raw);
  const olds = renameEntries().map(([oldId]) => oldId);
  const marks = renamedInList(() => "?");
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
    const supersededParents = new Set<string>();
    for (const [oldId, newId] of renameEntries()) {
      if (adoptParentSqlite(raw, oldId, newId) === "superseded") {
        supersededParents.add(oldId);
      }
      for (const c of columns.filter((x) => x.table !== "connectors")) {
        const drop = dropSupersededRowsSql(c, { new: "?", old: "?" });
        if (drop) {
          countSuperseded(superseded, c.table, sqliteChanges(raw.prepare(drop).run(oldId, newId)));
        }
      }
    }
    for (const c of columns.filter((x) => x.table !== "connectors")) {
      const rename = renameCaseSql(c.column, () => "?");
      changed += sqliteChanges(
        raw
          .prepare(`UPDATE ${quote(c.table)} SET ${quote(c.column)} = ${rename.sql} WHERE ${quote(c.column)} IN (${marks})`)
          .run(...rename.params, ...olds)
      );
    }
    // Old parents go last, once no child names them. One the current row
    // already covered is a superseded row, like the children above.
    const oldParents = partitionOldParents(olds, supersededParents);
    countSuperseded(superseded, "connectors", deleteConnectorsSqlite(raw, oldParents.superseded));
    changed += deleteConnectorsSqlite(raw, oldParents.copied);
    // A connection created without a name is labelled with its connector id.
    // Keep that placeholder in step with the id it names; a connection of
    // another connector that happens to carry the same text keeps it.
    for (const [oldId, newId] of renameEntries()) {
      changed += sqliteChanges(raw.prepare(renamePlaceholderLabelSql(() => "?")).run(newId, oldId, newId));
    }
    return { changedRows: changed + sumSuperseded(superseded), supersededRows: superseded };
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
  const marks = renamedInList((n) => `$${n}`);
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
    const supersededParents = new Set<string>();
    for (const [oldId, newId] of renameEntries()) {
      if ((await adoptParentPostgres(client, oldId, newId)) === "superseded") {
        supersededParents.add(oldId);
      }
      for (const c of columns.filter((x) => x.table !== "connectors")) {
        const drop = dropSupersededRowsSql(c, { new: "$2", old: "$1" });
        if (drop) {
          countSuperseded(superseded, c.table, (await client.query(drop, [oldId, newId])).rowCount ?? 0);
        }
      }
    }
    for (const c of columns.filter((x) => x.table !== "connectors")) {
      const rename = renameCaseSql(c.column, (n) => `$${n}`);
      const result = await client.query(
        `UPDATE ${quote(c.table)} SET ${quote(c.column)} = ${rename.sql}
          WHERE ${quote(c.column)} IN (${renamedInList((n) => `$${n}`, rename.params.length)})`,
        [...rename.params, ...olds]
      );
      changed += result.rowCount ?? 0;
    }
    // Old parents go last, once no child names them. One the current row
    // already covered is a superseded row, like the children above.
    const oldParents = partitionOldParents(olds, supersededParents);
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
    return { changedRows: changed + sumSuperseded(superseded), supersededRows: superseded };
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
