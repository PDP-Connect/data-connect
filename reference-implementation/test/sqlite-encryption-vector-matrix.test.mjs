// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import Database from "better-sqlite3-multiple-ciphers"
import * as sqliteVec from "sqlite-vec"

const DATABASE_KEY = "cross-platform-encryption-matrix-key"
const PLAINTEXT_MARKER = "encrypted-sqlite-vector-matrix-plaintext-marker"
const WRONG_DATABASE_KEY = "cross-platform-encryption-matrix-wrong-key"

function openKeyedDatabase(databasePath, key) {
  const database = new Database(databasePath)
  database.pragma(`key = '${key}'`)
  database.loadExtension(sqliteVec.getLoadablePath())
  return database
}

function vector(values) {
  return Buffer.from(Float32Array.from(values).buffer)
}

function assertVectorResults(database, expectedRows) {
  const rows = database
    .prepare(
      "SELECT rowid, distance FROM vectors WHERE embedding MATCH ? ORDER BY distance LIMIT ?"
    )
    .all(vector([1, 0, 0]), expectedRows.length)

  assert.deepEqual(
    rows.map(({ rowid }) => rowid),
    expectedRows.map(({ rowid }) => rowid)
  )
  for (const [index, expected] of expectedRows.entries()) {
    assert.ok(Math.abs(rows[index].distance - expected.distance) < 0.0001)
  }
}

test("encrypted SQLite supports sqlite-vec, FTS5, and persistence on this target", () => {
  const directory = mkdtempSync(join(tmpdir(), "pdpp-encryption-matrix-"))
  const databasePath = join(directory, "encrypted.sqlite")
  const expectedRows = [
    { rowid: 1, distance: 0 },
    { rowid: 3, distance: 1 },
    { rowid: 2, distance: Math.sqrt(2) },
  ]

  try {
    const database = openKeyedDatabase(databasePath, DATABASE_KEY)
    try {
      assert.equal(
        database.prepare("SELECT vec_version() AS version").get().version,
        "v0.1.9"
      )
      assert.equal(
        database.prepare("SELECT sqlite_version() AS version").get().version,
        "3.53.4"
      )

      database.pragma("journal_mode = WAL")
      database.exec(`
        CREATE TABLE ordinary_rows (id INTEGER PRIMARY KEY, value TEXT NOT NULL);
        CREATE VIRTUAL TABLE vectors USING vec0(embedding float[3]);
        CREATE VIRTUAL TABLE lexical_rows USING fts5(content);
      `)
      database
        .prepare("INSERT INTO ordinary_rows (value) VALUES (?)")
        .run(PLAINTEXT_MARKER)

      const insertVector = database.prepare(
        "INSERT INTO vectors (embedding) VALUES (?)"
      )
      insertVector.run(vector([1, 0, 0]))
      insertVector.run(vector([0, 1, 0]))
      insertVector.run(vector([1, 1, 0]))
      database
        .prepare("INSERT INTO lexical_rows (content) VALUES (?)")
        .run("vector search marker")

      assertVectorResults(database, expectedRows)
      assert.equal(
        database
          .prepare("SELECT rowid FROM lexical_rows WHERE lexical_rows MATCH ?")
          .get("marker").rowid,
        1
      )
      assert.deepEqual(
        database
          .prepare(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'vectors_%' ORDER BY name"
          )
          .all()
          .map(({ name }) => name),
        [
          "vectors_chunks",
          "vectors_info",
          "vectors_rowids",
          "vectors_vector_chunks00",
        ]
      )
      assert.equal(
        database.prepare("PRAGMA integrity_check").get().integrity_check,
        "ok"
      )

      database.exec("VACUUM")
      assertVectorResults(database, expectedRows)
    } finally {
      database.close()
    }

    const filePaths = [
      databasePath,
      `${databasePath}-wal`,
      `${databasePath}-shm`,
    ].filter(existsSync)
    const fileBytes = Buffer.concat(
      filePaths.map(filePath => readFileSync(filePath))
    )
    assert.notEqual(
      readFileSync(databasePath).subarray(0, 15).toString("ascii"),
      "SQLite format 3"
    )
    assert.equal(fileBytes.includes(Buffer.from(PLAINTEXT_MARKER)), false)

    assert.throws(() => {
      const wrongKeyDatabase = openKeyedDatabase(
        databasePath,
        WRONG_DATABASE_KEY
      )
      try {
        wrongKeyDatabase.prepare("SELECT count(*) FROM ordinary_rows").get()
      } finally {
        wrongKeyDatabase.close()
      }
    }, /file is not a database/)

    const reopenedDatabase = openKeyedDatabase(databasePath, DATABASE_KEY)
    try {
      assert.equal(
        reopenedDatabase.prepare("SELECT value FROM ordinary_rows").get().value,
        PLAINTEXT_MARKER
      )
      assertVectorResults(reopenedDatabase, expectedRows)
      assert.equal(
        reopenedDatabase
          .prepare(
            "SELECT count(*) AS count FROM lexical_rows WHERE lexical_rows MATCH ?"
          )
          .get("marker").count,
        1
      )
    } finally {
      reopenedDatabase.close()
    }
  } finally {
    rmSync(directory, { force: true, recursive: true })
  }
})
