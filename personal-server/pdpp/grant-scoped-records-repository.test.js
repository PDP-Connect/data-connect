import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

import {
  CursorExpiredError,
  GrantScopedRecordsRepository,
  RecordsRepositoryError,
} from "./grant-scoped-records-repository.js"

function withRepository(options = {}) {
  const directory = mkdtempSync(join(tmpdir(), "dataconnect-pdpp-records-"))
  const databasePath = join(directory, "records.sqlite")
  const repository = new GrantScopedRecordsRepository({
    databasePath,
    ...options,
  })
  return {
    repository,
    databasePath,
    directory,
    dispose() {
      repository.close()
      rmSync(directory, { recursive: true, force: true })
    },
  }
}

const TIMES = {
  created: "2026-01-01T00:00:00.000Z",
  updated: "2026-02-01T00:00:00.000Z",
  emitted: "2026-07-30T19:00:00.000Z",
}

function record(stream, id, extra = {}) {
  if (stream === "user")
    return {
      id,
      login: `user-${id}`,
      created_at: TIMES.created,
      updated_at: TIMES.updated,
      ...extra,
    }
  if (stream === "repositories")
    return {
      id,
      full_name: `owner/repo-${id}`,
      created_at: TIMES.created,
      pushed_at: TIMES.updated,
      ...extra,
    }
  return {
    id,
    full_name: `owner/star-${id}`,
    starred_at: TIMES.updated,
    ...extra,
  }
}

test("imports supported lossless GitHub snapshots atomically and keeps connection identities isolated", () => {
  const harness = withRepository()
  try {
    const result = harness.repository.importSnapshot({
      connectionId: "github-account-a",
      recordsByStream: {
        user: [
          {
            type: "RECORD",
            stream: "user",
            key: "1",
            data: record("user", "1"),
            emitted_at: TIMES.emitted,
          },
        ],
        repositories: [
          {
            stream: "repositories",
            key: "1",
            data: record("repositories", "1"),
            emitted_at: TIMES.emitted,
          },
        ],
        starred: [
          {
            stream: "starred",
            key: "1",
            data: record("starred", "1"),
            emitted_at: TIMES.emitted,
          },
        ],
      },
    })
    assert.deepEqual(
      result.map(entry => entry.changed),
      [true, true, true]
    )
    harness.repository.upsert({
      connectionId: "github-account-b",
      stream: "repositories",
      key: "1",
      data: record("repositories", "1", { full_name: "other/repo" }),
      emittedAt: TIMES.emitted,
    })
    assert.equal(
      harness.repository.getCurrent({
        connectionId: "github-account-a",
        stream: "repositories",
        key: "1",
      }).data.full_name,
      "owner/repo-1"
    )
    assert.equal(
      harness.repository.getCurrent({
        connectionId: "github-account-b",
        stream: "repositories",
        key: "1",
      }).data.full_name,
      "other/repo"
    )
  } finally {
    harness.dispose()
  }
})

test("rejects malformed snapshot envelopes without retaining earlier records", () => {
  const harness = withRepository()
  try {
    assert.throws(
      () =>
        harness.repository.importSnapshot({
          connectionId: "github-account-a",
          recordsByStream: {
            user: [
              {
                stream: "user",
                key: "1",
                data: record("user", "1"),
                emitted_at: TIMES.emitted,
              },
            ],
            repositories: [
              {
                stream: "repositories",
                key: "wrong",
                data: record("repositories", "2"),
                emitted_at: TIMES.emitted,
              },
            ],
          },
        }),
      error =>
        error instanceof RecordsRepositoryError &&
        error.code === "invalid_record_identity"
    )
    assert.equal(
      harness.repository.getCurrent({
        connectionId: "github-account-a",
        stream: "user",
        key: "1",
      }),
      null
    )
  } finally {
    harness.dispose()
  }
})

test("upserts and deletes are atomic, idempotent, and survive reopen", () => {
  const harness = withRepository()
  try {
    const input = {
      connectionId: "github-account-a",
      stream: "repositories",
      key: "1",
      data: record("repositories", "1"),
      emittedAt: TIMES.emitted,
    }
    assert.deepEqual(harness.repository.upsert(input), {
      changed: true,
      version: 1,
    })
    assert.deepEqual(harness.repository.upsert(input), { changed: false })
    assert.deepEqual(
      harness.repository.delete({
        ...input,
        emittedAt: "2026-07-30T20:00:00.000Z",
      }),
      { changed: true, version: 2 }
    )
    assert.deepEqual(
      harness.repository.delete({
        ...input,
        emittedAt: "2026-07-30T20:00:00.000Z",
      }),
      { changed: false }
    )
    harness.repository.close()
    const reopened = new GrantScopedRecordsRepository({
      databasePath: harness.databasePath,
    })
    assert.equal(
      reopened.getCurrent({
        connectionId: input.connectionId,
        stream: input.stream,
        key: input.key,
      }),
      null
    )
    assert.deepEqual(
      reopened.upsert({ ...input, emittedAt: "2026-07-30T21:00:00.000Z" }),
      { changed: true, version: 3 }
    )
    reopened.close()
  } finally {
    rmSync(harness.directory, { recursive: true, force: true })
  }
})

test("rolls back the current row, change log, and version allocation together", () => {
  let shouldFail = true
  const harness = withRepository({
    onMutationStep(step) {
      if (shouldFail && step === "after-version")
        throw new Error("simulated write failure")
    },
  })
  try {
    const input = {
      connectionId: "github-account-a",
      stream: "starred",
      key: "1",
      data: record("starred", "1"),
      emittedAt: TIMES.emitted,
    }
    assert.throws(
      () => harness.repository.upsert(input),
      /simulated write failure/
    )
    assert.equal(
      harness.repository.getCurrent({
        connectionId: input.connectionId,
        stream: input.stream,
        key: input.key,
      }),
      null
    )
    shouldFail = false
    assert.deepEqual(harness.repository.upsert(input), {
      changed: true,
      version: 1,
    })
  } finally {
    harness.dispose()
  }
})

test("a failed delete leaves its live current record and version intact", () => {
  let failDelete = false
  const harness = withRepository({
    onMutationStep(step, context) {
      if (
        failDelete &&
        context.operation === "delete" &&
        step === "after-current"
      ) {
        throw new Error("simulated delete failure")
      }
    },
  })
  try {
    const input = {
      connectionId: "github-account-a",
      stream: "starred",
      key: "1",
      data: record("starred", "1"),
      emittedAt: TIMES.emitted,
    }
    harness.repository.upsert(input)
    failDelete = true
    assert.throws(
      () =>
        harness.repository.delete({
          ...input,
          emittedAt: "2026-07-30T20:00:00.000Z",
        }),
      /simulated delete failure/
    )
    assert.equal(
      harness.repository.getCurrent({
        connectionId: input.connectionId,
        stream: input.stream,
        key: input.key,
      }).id,
      "1"
    )
    failDelete = false
    assert.deepEqual(
      harness.repository.delete({
        ...input,
        emittedAt: "2026-07-30T21:00:00.000Z",
      }),
      { changed: true, version: 2 }
    )
  } finally {
    harness.dispose()
  }
})

test("current records paginate by GitHub cursor then key, including nullable cursor values", () => {
  const harness = withRepository()
  try {
    for (const [id, pushedAt] of [
      ["a", "2026-01-01T00:00:00.000Z"],
      ["b", "2026-02-01T00:00:00.000Z"],
      ["c", null],
    ]) {
      harness.repository.upsert({
        connectionId: "github-account-a",
        stream: "repositories",
        key: id,
        data: record("repositories", id, { pushed_at: pushedAt }),
        emittedAt: TIMES.emitted,
      })
    }
    const first = harness.repository.listCurrent({
      connectionId: "github-account-a",
      stream: "repositories",
      limit: 2,
      order: "asc",
    })
    assert.deepEqual(
      first.data.map(entry => entry.id),
      ["a", "b"]
    )
    const second = harness.repository.listCurrent({
      connectionId: "github-account-a",
      stream: "repositories",
      limit: 2,
      order: "asc",
      cursor: first.next_cursor,
    })
    assert.deepEqual(
      second.data.map(entry => entry.id),
      ["c"]
    )
    assert.throws(
      () =>
        harness.repository.listCurrent({
          connectionId: "github-account-a",
          stream: "repositories",
          order: "desc",
          cursor: first.next_cursor,
        }),
      error => error.code === "invalid_cursor"
    )
  } finally {
    harness.dispose()
  }
})

test("current pagination retains its cursor field when a grant hides it", () => {
  const harness = withRepository()
  try {
    harness.repository.upsert({
      connectionId: "github-account-a",
      stream: "repositories",
      key: "a",
      data: record("repositories", "a", {
        pushed_at: "2026-02-01T00:00:00.000Z",
      }),
      emittedAt: TIMES.emitted,
    })
    harness.repository.upsert({
      connectionId: "github-account-a",
      stream: "repositories",
      key: "b",
      data: record("repositories", "b", {
        pushed_at: "2026-01-01T00:00:00.000Z",
      }),
      emittedAt: TIMES.emitted,
    })
    const grant = { fields: ["id", "full_name"] }
    const first = harness.repository.listCurrent({
      connectionId: "github-account-a",
      stream: "repositories",
      grant,
      limit: 1,
    })
    assert.deepEqual(
      first.data.map(entry => entry.id),
      ["b"]
    )
    assert.deepEqual(first.data[0].data, { id: "b", full_name: "owner/repo-b" })
    const second = harness.repository.listCurrent({
      connectionId: "github-account-a",
      stream: "repositories",
      grant,
      limit: 1,
      cursor: first.next_cursor,
    })
    assert.deepEqual(
      second.data.map(entry => entry.id),
      ["a"]
    )
  } finally {
    harness.dispose()
  }
})

test("grant constraints project current state and reject hidden-field filters", () => {
  const harness = withRepository()
  try {
    harness.repository.upsert({
      connectionId: "github-account-a",
      stream: "repositories",
      key: "1",
      data: record("repositories", "1", { language: "Rust", private: true }),
      emittedAt: TIMES.emitted,
    })
    const grant = {
      fields: ["id", "full_name", "language"],
      resources: ["1"],
      timeRange: { since: "2026-01-01T00:00:00.000Z" },
    }
    assert.deepEqual(
      harness.repository.listCurrent({
        connectionId: "github-account-a",
        stream: "repositories",
        grant,
      }).data[0].data,
      {
        id: "1",
        full_name: "owner/repo-1",
        language: "Rust",
      }
    )
    assert.throws(
      () =>
        harness.repository.listCurrent({
          connectionId: "github-account-a",
          stream: "repositories",
          grant,
          filter: { private: true },
        }),
      error => error.code === "field_not_granted"
    )
  } finally {
    harness.dispose()
  }
})

test("changes pin a horizon, suppress hidden-only updates, and emit authorized tombstones", () => {
  const harness = withRepository()
  try {
    const base = {
      connectionId: "github-account-a",
      stream: "repositories",
      key: "1",
      emittedAt: TIMES.emitted,
    }
    harness.repository.upsert({
      ...base,
      data: record("repositories", "1", { language: "Rust", private: false }),
    })
    const grant = { fields: ["id", "full_name", "language"] }
    const bootstrap = harness.repository.listChanges({
      ...base,
      grant,
      changesSince: "beginning",
      limit: 10,
    })
    const watermark = bootstrap.next_changes_since
    harness.repository.upsert({
      ...base,
      data: record("repositories", "1", { language: "Rust", private: true }),
      emittedAt: "2026-07-30T20:00:00.000Z",
    })
    assert.deepEqual(
      harness.repository.listChanges({
        ...base,
        grant,
        changesSince: watermark,
        limit: 10,
      }).data,
      []
    )
    harness.repository.upsert({
      ...base,
      data: record("repositories", "1", {
        language: "TypeScript",
        private: true,
      }),
      emittedAt: "2026-07-30T21:00:00.000Z",
    })
    harness.repository.upsert({
      connectionId: base.connectionId,
      stream: base.stream,
      key: "2",
      data: record("repositories", "2"),
      emittedAt: "2026-07-30T22:00:00.000Z",
    })
    const firstPage = harness.repository.listChanges({
      ...base,
      grant,
      changesSince: watermark,
      limit: 1,
    })
    assert.equal(firstPage.has_more, true)
    harness.repository.upsert({
      connectionId: base.connectionId,
      stream: base.stream,
      key: "3",
      data: record("repositories", "3"),
      emittedAt: "2026-07-30T23:00:00.000Z",
    })
    const terminal = harness.repository.listChanges({
      ...base,
      grant,
      cursor: firstPage.next_cursor,
      limit: 10,
    })
    assert.deepEqual(
      terminal.data.map(entry => entry.id),
      ["2"]
    )
    assert.ok(terminal.next_changes_since)
    harness.repository.delete({
      ...base,
      emittedAt: "2026-07-31T00:00:00.000Z",
    })
    const deleted = harness.repository.listChanges({
      ...base,
      grant,
      changesSince: terminal.next_changes_since,
      limit: 10,
    })
    assert.deepEqual(deleted.data, [
      {
        object: "record",
        id: "3",
        stream: "repositories",
        data: { id: "3", full_name: "owner/repo-3" },
        emitted_at: "2026-07-30T23:00:00.000Z",
      },
      {
        object: "record",
        id: "1",
        stream: "repositories",
        deleted: true,
        deleted_at: "2026-07-31T00:00:00.000Z",
        emitted_at: "2026-07-31T00:00:00.000Z",
      },
    ])
  } finally {
    harness.dispose()
  }
})

test("a bootstrap continuation reads the snapshot selected by its first page", () => {
  const harness = withRepository()
  try {
    const base = {
      connectionId: "github-account-a",
      stream: "repositories",
      emittedAt: TIMES.emitted,
    }
    harness.repository.upsert({
      ...base,
      key: "1",
      data: record("repositories", "1", { language: "Rust" }),
    })
    harness.repository.upsert({
      ...base,
      key: "2",
      data: record("repositories", "2", { language: "Go" }),
    })
    const first = harness.repository.listChanges({
      ...base,
      changesSince: "beginning",
      limit: 1,
    })
    assert.deepEqual(
      first.data.map(entry => entry.id),
      ["1"]
    )
    harness.repository.upsert({
      ...base,
      key: "2",
      data: record("repositories", "2", { language: "TypeScript" }),
      emittedAt: "2026-07-30T20:00:00.000Z",
    })
    const second = harness.repository.listChanges({
      ...base,
      cursor: first.next_cursor,
      limit: 1,
    })
    assert.deepEqual(second.data, [
      {
        object: "record",
        id: "2",
        stream: "repositories",
        data: {
          id: "2",
          full_name: "owner/repo-2",
          created_at: TIMES.created,
          pushed_at: TIMES.updated,
          language: "Go",
        },
        emitted_at: TIMES.emitted,
      },
    ])
  } finally {
    harness.dispose()
  }
})

test("expires changes_since tokens that predate retained history", () => {
  const harness = withRepository({ changeHistoryLimit: 1 })
  try {
    const input = {
      connectionId: "github-account-a",
      stream: "user",
      key: "1",
      emittedAt: TIMES.emitted,
    }
    harness.repository.upsert({ ...input, data: record("user", "1") })
    const watermark = harness.repository.listChanges({
      ...input,
      changesSince: "beginning",
    }).next_changes_since
    harness.repository.upsert({
      ...input,
      data: record("user", "1", { name: "second" }),
      emittedAt: "2026-07-30T20:00:00.000Z",
    })
    harness.repository.upsert({
      ...input,
      data: record("user", "1", { name: "third" }),
      emittedAt: "2026-07-30T21:00:00.000Z",
    })
    assert.throws(
      () =>
        harness.repository.listChanges({ ...input, changesSince: watermark }),
      CursorExpiredError
    )
    assert.deepEqual(
      harness.repository
        .listChanges({ ...input, changesSince: "beginning" })
        .data.map(entry => entry.data.name),
      ["third"]
    )
  } finally {
    harness.dispose()
  }
})
