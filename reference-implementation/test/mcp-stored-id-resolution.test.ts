// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
} from "node:fs"
import { homedir } from "node:os"
import { join, resolve } from "node:path"
import test from "node:test"
import { getDb } from "../server/db.ts"
import { startServer } from "../server/index.ts"
import { replay } from "./helpers/mcp-existing-client-session.ts"
import { assertMcpBaseProvenance, MCP_EXISTING_CLIENT_BASE } from "./helpers/mcp-existing-client-provenance.ts"

const worktree = process.env.MCP_STORED_ID_WORKTREE
const baseWorktree = process.env.MCP_STORED_ID_BASE_WORKTREE
const waiting =
  "TODO / WAITING FOR IDENTITY-LANE P4: set MCP_STORED_ID_WORKTREE to the candidate checkout and MCP_STORED_ID_BASE_WORKTREE to the unchanged 3282ac2f5e seeder checkout."

interface StoredSession {
  session: { storedIds: Record<string, unknown> }
}

interface SeededFixture {
  asPort: string
  client: string
  clientCapture: StoredSession
  clientSubject: string
  package: string
  packageCapture: StoredSession
  packageSubject: string
  rsPort: string
}

function assertWorktrees(): void {
  assert(worktree, waiting)
  assert(baseWorktree, waiting)
  const expectedRoot = realpathSync(
    join(resolve(worktree), "reference-implementation")
  )
  assert.equal(
    realpathSync(process.cwd()),
    expectedRoot,
    `MCP_STORED_ID_WORKTREE points to ${expectedRoot}, but this test runs from ${realpathSync(process.cwd())}`
  )
  assert(
    existsSync(join(expectedRoot, "server/auth.ts")),
    "candidate worktree has no reference server"
  )
  const seeder = realpathSync(resolve(baseWorktree as string))
  const candidate = realpathSync(resolve(worktree as string))
  assert.notEqual(
    candidate,
    seeder,
    "stored-ID candidate must differ from its base seeder worktree"
  )
  const actualRevision = assertMcpBaseProvenance(
    seeder,
    process.env.MCP_STORED_ID_BASE_REV ?? MCP_EXISTING_CLIENT_BASE
  )
  const candidateRevision = execFileSync(
    "git",
    ["-C", candidate, "rev-parse", "HEAD"],
    { encoding: "utf8" }
  ).trim()
  assert.notEqual(
    candidateRevision,
    actualRevision,
    "stored-ID candidate revision must differ from the base seeder revision"
  )
}

export async function replayStoredSession(
  rsUrl: string,
  token: string,
  tokenKind: "client" | "package",
  base: StoredSession
): Promise<void> {
  const candidate = await replay(
    rsUrl,
    token,
    tokenKind,
    base.session.storedIds
  )
  const expected = base.session.storedIds
  const actual = (candidate.session as Record<string, unknown>)
    .storedIds as Record<string, unknown>
  assert.equal(
    actual.searchResultId,
    expected.searchResultId,
    `${tokenKind}: stored search id changed`
  )
  assert.deepEqual(
    actual.searchResultIds,
    expected.searchResultIds,
    `${tokenKind}: stored search result ids changed`
  )
  assert.equal(
    actual.fetchId,
    expected.fetchId,
    `${tokenKind}: stored fetch id changed`
  )
  assert.deepEqual(
    actual.fetchIds,
    expected.fetchIds,
    `${tokenKind}: captured record handles changed`
  )
  assert.deepEqual(
    actual.readIds,
    expected.readIds,
    `${tokenKind}: bounded read handles changed`
  )
  assert.deepEqual(
    actual.connectionIds,
    expected.connectionIds,
    `${tokenKind}: adopted connection ids changed`
  )
  assert.deepEqual(
    actual.recordUris,
    expected.recordUris,
    `${tokenKind}: stored record URIs changed`
  )
  assert.deepEqual(
    actual.readArgsList,
    expected.readArgsList,
    `${tokenKind}: stored field-window arguments changed`
  )
  const observed = candidate.session as Record<string, unknown>
  const captured = base.session as Record<string, unknown>
  for (const key of ["observedConnectionIds", "observedRecordUris"]) {
    const current = observed[key]
    const previous = captured[key]
    assert(Array.isArray(current) && Array.isArray(previous))
    assert(
      previous.every(value => current.includes(value)),
      `${tokenKind}: captured ${key} disappeared during replay`
    )
  }
}

test(
  "TODO [P4 stored-ID resolution] grandfathered ChatGPT handles resolve after identity cutover",
  { skip: worktree ? undefined : waiting },
  async () => {
    assertWorktrees()
    const scratchRoot = join(homedir(), ".tmp/mcp-profile-1014")
    mkdirSync(scratchRoot, { recursive: true })
    const scratch = mkdtempSync(join(scratchRoot, "mcp-stored-id-resolution-"))
    const dbPath = join(scratch, "legacy.sqlite")
    const metadataPath = join(scratch, "fixture.json")
    const basePackage = join(
      resolve(baseWorktree as string),
      "reference-implementation"
    )
    execFileSync(
      "node",
      [
        "--import",
        "tsx",
        "test/scripts/seed-mcp-audience-migration-fixture.ts",
        dbPath,
        metadataPath,
      ],
      { cwd: basePackage, stdio: "pipe" }
    )
    const fixture = JSON.parse(
      readFileSync(metadataPath, "utf8")
    ) as SeededFixture
    const server = await startServer({
      asPort: Number(fixture.asPort),
      dbPath,
      ownerAuthPassword: "",
      quiet: true,
      rsPort: Number(fixture.rsPort),
    })
    try {
      const rsUrl = `http://localhost:${fixture.rsPort}`
      const subjectFor = (token: string): string => {
        const row = getDb()
          .prepare("SELECT subject_id FROM tokens WHERE token_id = ?")
          .get(token) as { subject_id: string } | undefined
        assert(row?.subject_id, `candidate lost stored subject for ${token}`)
        return row.subject_id
      }
      assert.equal(
        subjectFor(fixture.client),
        fixture.clientSubject,
        "client subject id changed across cutover"
      )
      assert.equal(
        subjectFor(fixture.package),
        fixture.packageSubject,
        "package subject id changed across cutover"
      )
      await replayStoredSession(
        rsUrl,
        fixture.client,
        "client",
        fixture.clientCapture
      )
      await replayStoredSession(
        rsUrl,
        fixture.package,
        "package",
        fixture.packageCapture
      )
    } finally {
      server.schedulerManager?.stop?.()
      server.asServer.closeAllConnections?.()
      server.rsServer.closeAllConnections?.()
      await Promise.allSettled([
        new Promise<void>(resolveClose =>
          server.asServer.close(() => resolveClose())
        ),
        new Promise<void>(resolveClose =>
          server.rsServer.close(() => resolveClose())
        ),
      ])
      rmSync(scratch, { force: true, recursive: true })
    }
  }
)
