// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The four connector ids that older local collectors spelled with underscores
 * (`claude_code`) and the server used to rewrite to the manifest key
 * (`claude-code`) on every request. The rewrite is gone: a connector has one
 * id, its manifest key.
 *
 * This table is historical. Identity resolution never reads it. It has two
 * uses: the one-time data migration that renames stored rows, and the error
 * message that tells a client still sending an old id which key to use.
 * Nothing here gates a connector: an id that is not in the table behaves as
 * any other id does.
 */

import type { PoolClient } from "pg";

export const RETIRED_CONNECTOR_IDS: Readonly<Record<string, string>> = Object.freeze({
  apple_photos: "apple-photos",
  claude_code: "claude-code",
  google_messages: "google-messages",
  google_takeout: "google-takeout",
});

/** The current key for a retired id, or null when the value is not a retired id. */
export function currentKeyForRetiredConnectorId(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return Object.hasOwn(RETIRED_CONNECTOR_IDS, trimmed) ? (RETIRED_CONNECTOR_IDS[trimmed] ?? null) : null;
}

/** "Unknown connector: <id>", plus the current key when <id> is a retired spelling. */
export function unknownConnectorMessage(connectorId: string): string {
  const current = currentKeyForRetiredConnectorId(connectorId);
  return current
    ? `Unknown connector: ${connectorId}. This id was renamed; use ${current}.`
    : `Unknown connector: ${connectorId}`;
}

/** Postgres migration receipt id. Versioned: a behavior change ships as a new id. */
export const RETIRED_CONNECTOR_ID_MIGRATION_ID = "retired_connector_ids_v1";

const ID_COLUMN_NAMES = ["connector_id", "connector_key"] as const;

interface IdColumn {
  column: string;
  /** Primary-key columns of the table other than this one; null when this column is not part of the primary key. */
  otherKeyColumns: string[] | null;
  table: string;
}

const quote = (identifier: string): string => `"${identifier.replaceAll('"', '""')}"`;

/** SQL that, for one id column, deletes rows under `old` that a row under `new` already covers. */
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

const retiredEntries = (): [string, string][] => Object.entries(RETIRED_CONNECTOR_IDS);

/** `CASE <col> WHEN old THEN new ... END` over all retired ids, so each table is updated in one scan. */
function renameCaseSql(column: string, placeholder: (n: number) => string): { params: string[]; sql: string } {
  const entries = retiredEntries();
  const params = entries.flatMap(([oldId, newId]) => [oldId, newId]);
  const whens = entries.map((_, i) => `WHEN ${placeholder(2 * i + 1)} THEN ${placeholder(2 * i + 2)}`).join(" ");
  return { params, sql: `CASE ${quote(column)} ${whens} ELSE ${quote(column)} END` };
}

/** Placeholders for the retired ids, numbered after `offset` earlier parameters. */
function retiredInList(placeholder: (n: number) => string, offset = 0): string {
  return retiredEntries()
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
 * Rename stored retired connector ids to their current keys in one transaction.
 * Returns the number of rows changed; 0 (and no write) when no retired id is stored.
 *
 * Order respects the foreign keys to `connectors(connector_id)`: the current
 * key's `connectors` row is created first, every referencing row is moved,
 * and the retired row is deleted last. A row keyed by the retired id that a
 * row keyed by the current id already covers is dropped (the current row
 * wins); any other unique-key collision aborts the migration with the
 * database's error rather than merging data.
 */
export function migrateRetiredConnectorIdsSqlite(raw: SqliteLike): number {
  const columns = sqliteIdColumns(raw);
  const olds = retiredEntries().map(([oldId]) => oldId);
  const marks = retiredInList(() => "?");
  const anyStored = columns.some(
    (c) =>
      raw.prepare(`SELECT 1 FROM ${quote(c.table)} WHERE ${quote(c.column)} IN (${marks}) LIMIT 1`).get(...olds) !==
      undefined
  );
  if (!anyStored) {
    return 0;
  }
  const changes = (result: unknown): number => Number((result as { changes?: number }).changes ?? 0);
  const run = raw.transaction(() => {
    let changed = 0;
    for (const [oldId, newId] of retiredEntries()) {
      const parent = raw.prepare("SELECT * FROM connectors WHERE connector_id = ?").get(oldId);
      if (parent && raw.prepare("SELECT 1 FROM connectors WHERE connector_id = ?").get(newId) === undefined) {
        const copy: Record<string, unknown> = { ...parent, connector_id: newId, manifest: rewriteManifestIds(parent.manifest, oldId, newId) };
        const names = Object.keys(copy);
        raw
          .prepare(`INSERT INTO connectors (${names.map(quote).join(", ")}) VALUES (${names.map(() => "?").join(", ")})`)
          .run(...names.map((n) => copy[n]));
      }
      for (const c of columns.filter((x) => x.table !== "connectors")) {
        const drop = dropSupersededRowsSql(c, { new: "?", old: "?" });
        if (drop) {
          raw.prepare(drop).run(oldId, newId);
        }
      }
    }
    for (const c of columns.filter((x) => x.table !== "connectors")) {
      const rename = renameCaseSql(c.column, () => "?");
      changed += changes(
        raw
          .prepare(`UPDATE ${quote(c.table)} SET ${quote(c.column)} = ${rename.sql} WHERE ${quote(c.column)} IN (${marks})`)
          .run(...rename.params, ...olds)
      );
    }
    changed += changes(raw.prepare(`DELETE FROM connectors WHERE connector_id IN (${marks})`).run(...olds));
    // A connection created without a name is labelled with its connector id.
    // Keep that placeholder in step with the id it names.
    for (const [oldId, newId] of retiredEntries()) {
      changed += changes(
        raw.prepare("UPDATE connector_instances SET display_name = ? WHERE display_name = ?").run(newId, oldId)
      );
    }
    return changed;
  });
  return run.immediate();
}

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
 * Postgres counterpart of {@link migrateRetiredConnectorIdsSqlite}. The caller
 * owns the migration receipt; this function runs the rename in one transaction
 * and returns the number of rows changed (0, with no write, when no retired
 * id is stored).
 */
export async function migrateRetiredConnectorIdsPostgres(client: PoolClient): Promise<number> {
  const columns = await postgresIdColumns(client);
  const olds = retiredEntries().map(([oldId]) => oldId);
  const marks = retiredInList((n) => `$${n}`);
  let anyStored = false;
  for (const c of columns) {
    const hit = await client.query(`SELECT 1 FROM ${quote(c.table)} WHERE ${quote(c.column)} IN (${marks}) LIMIT 1`, olds);
    if (hit.rowCount) {
      anyStored = true;
      break;
    }
  }
  if (!anyStored) {
    return 0;
  }
  await client.query("BEGIN");
  try {
    let changed = 0;
    for (const [oldId, newId] of retiredEntries()) {
      const parent = await client.query("SELECT * FROM connectors WHERE connector_id = $1", [oldId]);
      const current = await client.query("SELECT 1 FROM connectors WHERE connector_id = $1", [newId]);
      const parentRow = parent.rows[0] as Record<string, unknown> | undefined;
      if (parentRow && current.rowCount === 0) {
        const copy: Record<string, unknown> = { ...parentRow, connector_id: newId, manifest: rewriteManifestIds(parentRow.manifest, oldId, newId) };
        const names = Object.keys(copy);
        await client.query(
          `INSERT INTO connectors (${names.map(quote).join(", ")}) VALUES (${names.map((_, i) => `$${i + 1}`).join(", ")})`,
          names.map((n) => copy[n])
        );
      }
      for (const c of columns.filter((x) => x.table !== "connectors")) {
        const drop = dropSupersededRowsSql(c, { new: "$2", old: "$1" });
        if (drop) {
          await client.query(drop, [oldId, newId]);
        }
      }
    }
    for (const c of columns.filter((x) => x.table !== "connectors")) {
      const rename = renameCaseSql(c.column, (n) => `$${n}`);
      const result = await client.query(
        `UPDATE ${quote(c.table)} SET ${quote(c.column)} = ${rename.sql}
          WHERE ${quote(c.column)} IN (${retiredInList((n) => `$${n}`, rename.params.length)})`,
        [...rename.params, ...olds]
      );
      changed += result.rowCount ?? 0;
    }
    const removed = await client.query(`DELETE FROM connectors WHERE connector_id IN (${marks})`, olds);
    changed += removed.rowCount ?? 0;
    // A connection created without a name is labelled with its connector id.
    // Keep that placeholder in step with the id it names.
    for (const [oldId, newId] of retiredEntries()) {
      const labels = await client.query("UPDATE connector_instances SET display_name = $1 WHERE display_name = $2", [
        newId,
        oldId,
      ]);
      changed += labels.rowCount ?? 0;
    }
    await client.query("COMMIT");
    return changed;
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // Keep the original error.
    }
    throw err;
  }
}
