// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict"
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
} from "node:fs"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import type BetterSqlite3 from "better-sqlite3"
import { closeDb, initDb } from "../server/db.ts"

const Database = createRequire(import.meta.url)(
  "better-sqlite3-multiple-ciphers"
) as typeof BetterSqlite3

const DATABASE_KEY = "sqlite-encryption-test-key"
const WRONG_DATABASE_KEY = "wrong-sqlite-encryption-test-key"
const SQLITE_HEADER = "SQLite format 3\0"

function temporaryDatabase(prefix: string): {
  directory: string
  path: string
} {
  const directory = mkdtempSync(join(tmpdir(), prefix))
  return { directory, path: join(directory, "pdpp.sqlite") }
}

function vector(values: number[]): Buffer {
  return Buffer.from(Float32Array.from(values).buffer as ArrayBuffer)
}

function closeAndRemove(directory: string): void {
  closeDb()
  rmSync(directory, { force: true, recursive: true })
}

function createPlaintextWalFixture(path: string): void {
  const database = new Database(path)
  database.pragma("journal_mode = WAL")
  database.exec(
    "CREATE TABLE known_table (value TEXT NOT NULL); " +
      "INSERT INTO known_table(value) VALUES ('preserve me');"
  )
  database.close()
}

test("fresh keyed SQLite databases are encrypted and reject the wrong key", () => {
  const { directory, path } = temporaryDatabase("pdpp-sqlite-encrypted-")
  try {
    const database = initDb(path, { encryptionKey: DATABASE_KEY })
    database.prepare("CREATE TABLE encryption_probe (value TEXT)").run()
    closeDb()

    assert.notEqual(
      readFileSync(path).subarray(0, SQLITE_HEADER.length).toString("ascii"),
      SQLITE_HEADER
    )
    assert.throws(
      () => initDb(path, { encryptionKey: WRONG_DATABASE_KEY }),
      /Could not open the encrypted SQLite vault/
    )
  } finally {
    closeAndRemove(directory)
  }
})

test("sqlite-vec virtual tables and KNN queries work after encryption", () => {
  const { directory, path } = temporaryDatabase("pdpp-sqlite-vec-encrypted-")
  try {
    const database = initDb(path, { encryptionKey: DATABASE_KEY })
    assert.equal(database.vectorIndexKind, "sqlite-vec")
    database.exec(
      "CREATE VIRTUAL TABLE encrypted_vectors USING vec0(embedding float[2])"
    )
    database
      .prepare("INSERT INTO encrypted_vectors(rowid, embedding) VALUES (?, ?)")
      .run(1n, vector([1, 0]))
    database
      .prepare("INSERT INTO encrypted_vectors(rowid, embedding) VALUES (?, ?)")
      .run(2n, vector([0, 1]))

    const nearest = database
      .prepare(
        "SELECT rowid, distance FROM encrypted_vectors WHERE embedding MATCH ? ORDER BY distance LIMIT 1"
      )
      .get(vector([0.9, 0.1])) as { rowid: number; distance: number }
    assert.equal(nearest.rowid, 1)
    assert.ok(nearest.distance < 0.2)
  } finally {
    closeAndRemove(directory)
  }
})

test("plaintext WAL databases migrate with data, integrity, and WAL mode preserved", () => {
  const { directory, path } = temporaryDatabase("pdpp-sqlite-migrate-")
  try {
    createPlaintextWalFixture(path)
    const database = initDb(path, { encryptionKey: DATABASE_KEY })
    assert.equal(database.pragma("journal_mode", { simple: true }), "wal")
    assert.equal(database.pragma("integrity_check", { simple: true }), "ok")
    assert.deepEqual(database.prepare("SELECT value FROM known_table").get(), {
      value: "preserve me",
    })
    closeDb()

    assert.notEqual(
      readFileSync(path).subarray(0, SQLITE_HEADER.length).toString("ascii"),
      SQLITE_HEADER
    )
    assert.equal(
      readdirSync(directory).some(name =>
        name.startsWith(".pdpp-sqlite-encryption-backup-")
      ),
      false
    )
  } finally {
    closeAndRemove(directory)
  }
})

test("a mid-migration failure restores the original plaintext WAL database", () => {
  const { directory, path } = temporaryDatabase("pdpp-sqlite-migrate-rollback-")
  try {
    createPlaintextWalFixture(path)
    assert.throws(
      () =>
        initDb(path, {
          encryptionKey: DATABASE_KEY,
          onEncryptionMigrationStep(step) {
            if (step === "rekey") {
              throw new Error("injected migration failure")
            }
          },
        }),
      /SQLite vault encryption migration failed; the plaintext database was restored/
    )
    assert.equal(
      readFileSync(path).subarray(0, SQLITE_HEADER.length).toString("ascii"),
      SQLITE_HEADER
    )
    assert.equal(existsSync(path + "-wal"), false)

    const restored = new Database(path)
    assert.deepEqual(restored.prepare("SELECT value FROM known_table").get(), {
      value: "preserve me",
    })
    restored.close()
    assert.equal(
      readdirSync(directory).some(name =>
        name.startsWith(".pdpp-sqlite-encryption-backup-")
      ),
      false
    )
  } finally {
    closeAndRemove(directory)
  }
})

test("an encrypted database without its key fails closed", () => {
  const { directory, path } = temporaryDatabase("pdpp-sqlite-missing-key-")
  try {
    const database = initDb(path, { encryptionKey: DATABASE_KEY })
    database.prepare("CREATE TABLE missing_key_probe (value TEXT)").run()
    closeDb()

    assert.throws(
      () => initDb(path, { encryptionKey: "" }),
      /PDPP_DATABASE_ENCRYPTION_KEY is missing.*refusing to create a replacement key/
    )
  } finally {
    closeAndRemove(directory)
  }
})

test("a Docker-style SQLite start without a key remains plaintext", () => {
  const { directory, path } = temporaryDatabase("pdpp-sqlite-docker-")
  try {
    const database = initDb(path, { encryptionKey: "" })
    database.prepare("CREATE TABLE plaintext_probe (value TEXT)").run()
    assert.equal(
      readFileSync(path).subarray(0, SQLITE_HEADER.length).toString("ascii"),
      SQLITE_HEADER
    )
  } finally {
    closeAndRemove(directory)
  }
})
