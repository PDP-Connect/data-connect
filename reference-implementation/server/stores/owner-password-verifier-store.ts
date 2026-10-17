// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { readFile, unlink } from "node:fs/promises";
import { getDb } from "../db.ts";
import type { OwnerPasswordVerifier } from "../owner-password-verifier.ts";
import { createOwnerPasswordVerifier, parseOwnerPasswordVerifier } from "../owner-password-verifier.ts";
import {
  isPostgresStorageBackend,
  postgresQuery,
  type PostgresTransactionClient,
  withPostgresTransaction,
} from "../postgres-storage.ts";

export async function lockOwnerPasswordVerifierRevision(client: PostgresTransactionClient): Promise<void> {
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended('pdpp_owner_password_verifier_revision', 0))");
}

export interface OwnerPasswordVerifierStore {
  isDurable: () => boolean;
  read: () => Promise<OwnerPasswordVerifier | null>;
  readVersioned: () => Promise<{ verifier: OwnerPasswordVerifier; revision: string } | null>;
  write: (verifier: OwnerPasswordVerifier) => Promise<void>;
  writeIfMissing: (verifier: OwnerPasswordVerifier) => Promise<boolean>;
  writeAndRevokeAccess: (
    verifier: OwnerPasswordVerifier,
    subjectId: string,
    keepSessionIdHash?: string | null,
    expectedRevision?: string
  ) => Promise<boolean>;
}

/** Set an app-managed owner password without persisting its plaintext. */
export async function setOwnerPassword(
  store: OwnerPasswordVerifierStore,
  password: string
): Promise<OwnerPasswordVerifier> {
  const verifier = await createOwnerPasswordVerifier(password);
  await store.write(verifier);
  return verifier;
}

interface VerifierRow {
  verifier_json: string;
}

export function ownerPasswordVerifierRevision(serializedVerifier: string): string {
  return createHash("sha256").update(serializedVerifier).digest("base64url");
}

const TRAILING_NEWLINE_PATTERN = /\r?\n$/u;

function withDurableSqliteWrite<T>(write: (database: ReturnType<typeof getDb>) => T): T {
  const database = getDb();
  const previousSynchronous = database.pragma("synchronous", { simple: true });
  if (typeof previousSynchronous !== "number") {
    throw new Error("Unable to read SQLite synchronous mode before owner password write.");
  }
  if (previousSynchronous !== 2) {
    database.pragma("synchronous = FULL");
  }
  try {
    return write(database);
  } finally {
    if (previousSynchronous !== 2) {
      database.pragma(`synchronous = ${previousSynchronous}`);
    }
  }
}

export function createOwnerPasswordVerifierStore(): OwnerPasswordVerifierStore {
  return {
    isDurable(): boolean {
      if (isPostgresStorageBackend()) {
        return true;
      }
      const mainDatabase = getDb()
        .prepare("PRAGMA database_list")
        .all<{ name: string; file: string }>()
        .find((database) => database.name === "main");
      return Boolean(mainDatabase?.file);
    },
    async read(): Promise<OwnerPasswordVerifier | null> {
      return (await this.readVersioned())?.verifier ?? null;
    },
    async readVersioned(): Promise<{ verifier: OwnerPasswordVerifier; revision: string } | null> {
      const row = isPostgresStorageBackend()
        ? (await postgresQuery<VerifierRow>("SELECT verifier_json FROM owner_password_verifier WHERE singleton = 1"))
            .rows[0]
        : getDb().prepare("SELECT verifier_json FROM owner_password_verifier WHERE singleton = 1").get<VerifierRow>();
      if (!row) {
        return null;
      }
      let value: unknown;
      try {
        value = JSON.parse(row.verifier_json);
      } catch (error) {
        throw new Error("Stored owner password verifier is malformed.", { cause: error });
      }
      return {
        revision: ownerPasswordVerifierRevision(row.verifier_json),
        verifier: parseOwnerPasswordVerifier(value),
      };
    },
    async write(verifier): Promise<void> {
      const serialized = JSON.stringify(parseOwnerPasswordVerifier(verifier));
      const now = Math.floor(Date.now() / 1000);
      if (isPostgresStorageBackend()) {
        return await withPostgresTransaction(async (client) => {
          await lockOwnerPasswordVerifierRevision(client);
          await client.query("SET LOCAL synchronous_commit = on");
          await client.query(
            `INSERT INTO owner_password_verifier(singleton, verifier_json, created_at, updated_at)
             VALUES(1, $1, $2, $2)
             ON CONFLICT(singleton) DO UPDATE SET verifier_json = EXCLUDED.verifier_json, updated_at = EXCLUDED.updated_at`,
            [serialized, now]
          );
        });
      }
      withDurableSqliteWrite((database) =>
        database
          .transaction(() => {
            database
              .prepare(
                `INSERT INTO owner_password_verifier(singleton, verifier_json, created_at, updated_at)
             VALUES(1, ?, ?, ?)
             ON CONFLICT(singleton) DO UPDATE SET verifier_json = excluded.verifier_json, updated_at = excluded.updated_at`
              )
              .run(serialized, now, now);
          })
          .immediate()
      );
    },
    async writeIfMissing(verifier): Promise<boolean> {
      const serialized = JSON.stringify(parseOwnerPasswordVerifier(verifier));
      const now = Math.floor(Date.now() / 1000);
      if (isPostgresStorageBackend()) {
        return await withPostgresTransaction(async (client) => {
          await lockOwnerPasswordVerifierRevision(client);
          await client.query("SET LOCAL synchronous_commit = on");
          const result = await client.query<{ singleton: number }>(
            `INSERT INTO owner_password_verifier(singleton, verifier_json, created_at, updated_at)
             VALUES(1, $1, $2, $2)
             ON CONFLICT(singleton) DO NOTHING
             RETURNING singleton`,
            [serialized, now]
          );
          return result.rows.length === 1;
        });
      }
      return withDurableSqliteWrite(
        (database) =>
          database
            .prepare(
              `INSERT OR IGNORE INTO owner_password_verifier(singleton, verifier_json, created_at, updated_at)
           VALUES(1, ?, ?, ?)`
            )
            .run(serialized, now, now).changes === 1
      );
    },
    async writeAndRevokeAccess(verifier, subjectId, keepSessionIdHash = null, expectedRevision): Promise<boolean> {
      const serialized = JSON.stringify(parseOwnerPasswordVerifier(verifier));
      const now = Math.floor(Date.now() / 1000);
      if (isPostgresStorageBackend()) {
        return await withPostgresTransaction(async (client) => {
          await lockOwnerPasswordVerifierRevision(client);
          await client.query("SET LOCAL synchronous_commit = on");
          if (expectedRevision !== undefined) {
            const current = (
              await client.query<VerifierRow>(
                "SELECT verifier_json FROM owner_password_verifier WHERE singleton = 1 FOR UPDATE"
              )
            ).rows[0];
            if (!current || ownerPasswordVerifierRevision(current.verifier_json) !== expectedRevision) return false;
          }
          const update = await client.query(
            "UPDATE owner_password_verifier SET verifier_json = $1, updated_at = $2 WHERE singleton = 1 RETURNING singleton",
            [serialized, now]
          );
          if (update.rows.length !== 1) throw new Error("App-managed owner password verifier is missing.");
          await client.query(
            `UPDATE owner_sessions
                SET revoked_at = $1
              WHERE subject_id = $2 AND revoked_at IS NULL
                AND ($3::text IS NULL OR id_hash <> $3)`,
            [now, subjectId, keepSessionIdHash]
          );
          await client.query(
            "UPDATE tokens SET revoked = TRUE WHERE subject_id = $1 AND token_kind = 'owner' AND revoked = FALSE",
            [subjectId]
          );
          return true;
        });
      }
      return withDurableSqliteWrite((database) =>
        database
          .transaction(() => {
            if (expectedRevision !== undefined) {
              const current = database
                .prepare("SELECT verifier_json FROM owner_password_verifier WHERE singleton = 1")
                .get<VerifierRow>();
              if (!current || ownerPasswordVerifierRevision(current.verifier_json) !== expectedRevision) return false;
            }
            const update = database
              .prepare("UPDATE owner_password_verifier SET verifier_json = ?, updated_at = ? WHERE singleton = 1")
              .run(serialized, now);
            if (update.changes !== 1) throw new Error("App-managed owner password verifier is missing.");
            database
              .prepare(
                `UPDATE owner_sessions SET revoked_at = ?
                  WHERE subject_id = ? AND revoked_at IS NULL AND (? IS NULL OR id_hash <> ?)`
              )
              .run(now, subjectId, keepSessionIdHash, keepSessionIdHash);
            database
              .prepare("UPDATE tokens SET revoked = 1 WHERE subject_id = ? AND token_kind = 'owner' AND revoked = 0")
              .run(subjectId);
            return true;
          })
          .immediate()
      );
    },
  };
}

/** Import and remove the old first-boot plaintext file only after the DB row is readable. */
export async function importLegacyOwnerPasswordFile(
  filePath: string,
  store: OwnerPasswordVerifierStore,
  createVerifier: (password: string) => Promise<OwnerPasswordVerifier>
): Promise<{ imported: boolean; verifier: OwnerPasswordVerifier | null }> {
  if (!store.isDurable()) {
    return { imported: false, verifier: null };
  }

  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { imported: false, verifier: await store.read() };
    }
    throw new Error("Unable to read the legacy owner password file.", { cause: error });
  }

  // The old first-boot writer emitted a trailing newline. Preserve all other
  // characters because they may be part of the generated password.
  const password = raw.replace(TRAILING_NEWLINE_PATTERN, "");
  if (!password) {
    throw new Error("The legacy owner password file is empty.");
  }

  const existing = await store.read();
  let imported = false;
  if (!existing) {
    const verifier = await createVerifier(password);
    imported = await store.writeIfMissing(verifier);
  }
  const confirmed = await store.read();
  if (!confirmed) {
    throw new Error("Legacy owner password import did not persist.");
  }
  try {
    await unlink(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new Error("Unable to remove the legacy owner password file after import.", { cause: error });
    }
  }
  return { imported, verifier: confirmed };
}
