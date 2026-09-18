// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto"
import {
  closeSync,
  copyFileSync,
  existsSync,
  mkdtempSync,
  openSync,
  readSync,
  rmSync,
  statSync,
} from "node:fs"
import { basename, dirname, join } from "node:path"

export const DATABASE_ENCRYPTION_KEY_ENV = "PDPP_DATABASE_ENCRYPTION_KEY"
const SQLITE_HEADER = Buffer.from("SQLite format 3\0", "ascii")
const BACKUP_FILE_NAMES = ["", "-wal", "-shm"] as const

export interface SqliteEncryptionDatabase {
  close: () => SqliteEncryptionDatabase
  exec: (source: string) => SqliteEncryptionDatabase
  key: (key: Buffer) => number
  pragma: (source: string, options?: { simple?: boolean }) => unknown
  prepare: (sql: string) => {
    get: <T = Record<string, unknown>>(...params: unknown[]) => T | undefined
  }
  rekey: (key: Buffer) => number
}

export interface SqliteEncryptionDatabaseConstructor {
  new (filename: string, options: { timeout: number }): SqliteEncryptionDatabase
}

export type SqliteEncryptionMigrationStep =
  | "backup-created"
  | "opened-plaintext"
  | "journal-mode-delete"
  | "rekey"
  | "journal-mode-wal"
  | "integrity-check"
  | "known-table-read"

export interface SqliteEncryptionOptions {
  encryptionKey?: string
  onEncryptionMigrationStep?: (step: SqliteEncryptionMigrationStep) => void
}

interface BackupFile {
  backupPath: string
  sourcePath: string
}

interface DatabaseBackup {
  directory: string
  path: string
  files: BackupFile[]
}

function resolveEncryptionKey(
  value = process.env[DATABASE_ENCRYPTION_KEY_ENV]
): string | null {
  if (typeof value !== "string") {
    return null
  }
  const key = value.trim()
  return key.length > 0 ? key : null
}

function hasPlaintextSqliteHeader(path: string): boolean {
  if (!existsSync(path) || statSync(path).size === 0) {
    return true
  }
  const descriptor = openSync(path, "r")
  const header = Buffer.alloc(SQLITE_HEADER.length)
  try {
    return (
      readSync(descriptor, header, 0, header.length, 0) === header.length &&
      header.equals(SQLITE_HEADER)
    )
  } finally {
    closeSync(descriptor)
  }
}

function digestFile(path: string): string {
  const hash = createHash("sha256")
  const descriptor = openSync(path, "r")
  const buffer = Buffer.allocUnsafe(64 * 1024)
  try {
    let bytesRead = 0
    do {
      bytesRead = readSync(descriptor, buffer, 0, buffer.length, null)
      if (bytesRead > 0) {
        hash.update(buffer.subarray(0, bytesRead))
      }
    } while (bytesRead > 0)
  } finally {
    closeSync(descriptor)
  }
  return hash.digest("hex")
}

function copyAndVerify(sourcePath: string, backupPath: string): void {
  copyFileSync(sourcePath, backupPath)
  const sourceStat = statSync(sourcePath)
  const backupStat = statSync(backupPath)
  if (
    sourceStat.size !== backupStat.size ||
    digestFile(sourcePath) !== digestFile(backupPath)
  ) {
    throw new Error(
      "SQLite backup verification failed for " + basename(sourcePath)
    )
  }
}

function createDatabaseBackup(path: string): DatabaseBackup {
  const directory = mkdtempSync(
    join(dirname(path), ".pdpp-sqlite-encryption-backup-")
  )
  const files: BackupFile[] = []
  try {
    for (const suffix of BACKUP_FILE_NAMES) {
      const sourcePath = path + suffix
      if (!existsSync(sourcePath)) {
        continue
      }
      const backupPath = join(directory, basename(sourcePath))
      copyAndVerify(sourcePath, backupPath)
      files.push({ backupPath, sourcePath })
    }
    return { directory, files, path }
  } catch (error) {
    rmSync(directory, { force: true, recursive: true })
    throw error
  }
}

function restoreDatabaseBackup(backup: DatabaseBackup): void {
  for (const suffix of BACKUP_FILE_NAMES) {
    rmSync(backup.path + suffix, { force: true })
  }
  for (const file of backup.files) {
    copyAndVerify(file.backupPath, file.sourcePath)
  }
}

function notifyMigrationStep(
  options: SqliteEncryptionOptions,
  step: SqliteEncryptionMigrationStep
): void {
  options.onEncryptionMigrationStep?.(step)
}

function migratePlaintextDatabase(
  Database: SqliteEncryptionDatabaseConstructor,
  path: string,
  timeout: number,
  key: Buffer,
  options: SqliteEncryptionOptions
): void {
  const backup = createDatabaseBackup(path)
  let raw: SqliteEncryptionDatabase | null = null
  try {
    notifyMigrationStep(options, "backup-created")
    raw = new Database(path, { timeout })
    notifyMigrationStep(options, "opened-plaintext")
    const deleteJournalMode = raw.pragma("journal_mode = DELETE", {
      simple: true,
    })
    if (String(deleteJournalMode).toLowerCase() !== "delete") {
      throw new Error("SQLite did not enter DELETE journal mode before rekey")
    }
    notifyMigrationStep(options, "journal-mode-delete")
    raw.rekey(key)
    notifyMigrationStep(options, "rekey")
    const walJournalMode = raw.pragma("journal_mode = WAL", { simple: true })
    if (String(walJournalMode).toLowerCase() !== "wal") {
      throw new Error("SQLite did not restore WAL journal mode after rekey")
    }
    notifyMigrationStep(options, "journal-mode-wal")
    const integrity = raw.pragma("integrity_check", { simple: true })
    if (integrity !== "ok") {
      throw new Error("PRAGMA integrity_check returned " + String(integrity))
    }
    notifyMigrationStep(options, "integrity-check")
    raw.prepare("SELECT COUNT(*) AS count FROM sqlite_master").get()
    notifyMigrationStep(options, "known-table-read")
    raw.close()
    raw = null
    rmSync(backup.directory, { force: true, recursive: true })
  } catch (error) {
    try {
      raw?.close()
    } catch {
      // Restore is the load-bearing recovery path; a close failure must not
      // prevent it from running.
    }
    try {
      restoreDatabaseBackup(backup)
      rmSync(backup.directory, { force: true, recursive: true })
    } catch (restoreError) {
      throw new Error(
        "SQLite vault encryption migration failed and backup restore also failed. Preserve the database backup at " +
          backup.directory +
          " and do not restart until it is recovered.",
        { cause: restoreError }
      )
    }
    const detail = error instanceof Error ? error.message : String(error)
    throw new Error(
      "SQLite vault encryption migration failed; the plaintext database was restored. " +
        detail,
      { cause: error }
    )
  }
}

function assertDatabaseKey(raw: SqliteEncryptionDatabase, path: string): void {
  try {
    raw.prepare("SELECT COUNT(*) AS count FROM sqlite_master").get()
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new Error(
      "Could not open the encrypted SQLite vault at " +
        path +
        " with " +
        DATABASE_ENCRYPTION_KEY_ENV +
        ". Restore the database key from the OS keychain and restart. " +
        detail,
      { cause: error }
    )
  }
}

export function openSqliteDatabase(
  Database: SqliteEncryptionDatabaseConstructor,
  path: string,
  timeout: number,
  options: SqliteEncryptionOptions = {}
): SqliteEncryptionDatabase {
  if (
    path !== ":memory:" &&
    existsSync(path) &&
    !hasPlaintextSqliteHeader(path) &&
    !resolveEncryptionKey(options.encryptionKey)
  ) {
    throw new Error(
      "The SQLite vault at " +
        path +
        " is encrypted, but " +
        DATABASE_ENCRYPTION_KEY_ENV +
        " is missing. Restore the database key from the OS keychain and restart; refusing to create a replacement key."
    )
  }

  const encryptionKey = resolveEncryptionKey(options.encryptionKey)
  const key = encryptionKey === null ? null : Buffer.from(encryptionKey, "utf8")
  if (
    path !== ":memory:" &&
    key &&
    existsSync(path) &&
    hasPlaintextSqliteHeader(path) &&
    statSync(path).size > 0
  ) {
    migratePlaintextDatabase(Database, path, timeout, key, options)
  }

  let raw: SqliteEncryptionDatabase | null = null
  try {
    raw = new Database(path, { timeout })
    if (key && path !== ":memory:") {
      raw.key(key)
      assertDatabaseKey(raw, path)
    }
    return raw
  } catch (error) {
    try {
      raw?.close()
    } catch {
      // Preserve the original open error.
    }
    throw error
  }
}
