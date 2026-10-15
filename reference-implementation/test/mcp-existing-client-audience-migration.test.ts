// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { getDb } from "../server/db.ts";
import { startServer } from "../server/index.ts";
import { replay } from "./helpers/mcp-existing-client-session.ts";

type Stage = "P2" | "P3" | "P7";

const UNDECIDABLE_COUNT_COLUMN = /undecidable.*count|count.*undecidable/i;
const worktree = process.env.MCP_AUDIENCE_MIGRATION_WORKTREE;
const baseWorktree = process.env.MCP_AUDIENCE_MIGRATION_BASE_WORKTREE;
const stage = (process.env.MCP_AUDIENCE_MIGRATION_STAGE ?? "P2") as Stage;
const waiting =
  "TODO / WAITING FOR IDENTITY-LANE P2: set MCP_AUDIENCE_MIGRATION_WORKTREE to the P2/P3/P7 checkout, MCP_AUDIENCE_MIGRATION_BASE_WORKTREE to the base seeder checkout, and MCP_AUDIENCE_MIGRATION_STAGE to its boundary.";

function assertWorktreeIsCurrent(): void {
  assert(worktree, waiting);
  assert(baseWorktree, waiting);
  assert(["P2", "P3", "P7"].includes(stage), "stage must be P2, P3, or P7");
  const expectedRoot = realpathSync(join(resolve(worktree), "reference-implementation"));
  const currentRoot = realpathSync(process.cwd());
  assert.equal(
    currentRoot,
    expectedRoot,
    `MCP_AUDIENCE_MIGRATION_WORKTREE points to ${expectedRoot}, but this test runs from ${currentRoot}`
  );
  assert(existsSync(join(expectedRoot, "server/auth.ts")), "worktree has no reference server");
}

function assertPermanentRows(
  tokenIds: string[],
  expected: { kind: string; resource: string | null; packageId: string | null }
): void {
  const db = getDb();
  for (const tokenId of tokenIds) {
    const row = db
      .prepare(
        `SELECT token_kind, package_id, refresh_family_id, expires_at, resource
           FROM tokens WHERE token_id = ?`
      )
      .get(tokenId) as
      | {
          expires_at: string | null;
          package_id: string | null;
          refresh_family_id: string | null;
          resource: string | null;
          token_kind: string;
        }
      | undefined;
    assert(row, `expected permanent token row ${tokenId}`);
    assert.equal(row.token_kind, expected.kind);
    assert.equal(row.package_id, expected.packageId);
    assert.equal(row.expires_at, null, "census tokens do not expire");
    assert.equal(row.refresh_family_id, null, "census tokens have no refresh family");
    assert.equal(row.resource, expected.resource);
  }
}

function assertUndecidableRowsCounted(): void {
  const db = getDb();
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>;
  const counters: number[] = [];
  for (const { name } of tables) {
    const columns = db.prepare(`PRAGMA table_info("${name.replaceAll('"', '""')}")`).all() as Array<{
      name: string;
    }>;
    const countColumn = columns.find((column) => UNDECIDABLE_COUNT_COLUMN.test(column.name));
    if (!countColumn) {
      continue;
    }
    const value = db
      .prepare(`SELECT SUM("${countColumn.name.replaceAll('"', '""')}") AS count FROM "${name.replaceAll('"', '""')}"`)
      .get() as { count: number | null };
    if (typeof value.count === "number") {
      counters.push(value.count);
    }
  }
  assert(
    counters.some((count) => count > 0),
    "P2 migration must count undecidable legacy tokens while dual-accepting them"
  );
}

async function assertHttpStatus(url: string, token: string, expected: number, label: string): Promise<void> {
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });
  assert.equal(response.status, expected, `${label}: HTTP ${response.status}`);
}

interface SeededFixture {
  asPort: string;
  client: string;
  internalChildren: string[];
  package: string;
  packageId: string;
  rsPort: string;
  undecidable: string;
}

async function runPermanentTokenScenario(tokenKind: "client" | "package") {
  assertWorktreeIsCurrent();
  const scratchRoot = join(homedir(), ".tmp/mcp-profile-1014");
  mkdirSync(scratchRoot, { recursive: true });
  const scratch = mkdtempSync(join(scratchRoot, "mcp-audience-migration-"));
  const dbPath = join(scratch, "legacy.sqlite");
  const metadataPath = join(scratch, "fixture.json");
  const basePackage = join(resolve(baseWorktree as string), "reference-implementation");
  execFileSync(
    "node",
    ["--import", "tsx", "test/scripts/seed-mcp-audience-migration-fixture.ts", dbPath, metadataPath],
    { cwd: basePackage, stdio: "pipe" }
  );
  const fixture = JSON.parse(readFileSync(metadataPath, "utf8")) as SeededFixture;
  const server = await startServer({
    asPort: Number(fixture.asPort),
    dbPath,
    ownerAuthPassword: "",
    quiet: true,
    rsPort: Number(fixture.rsPort),
  });
  const rsUrl = `http://localhost:${fixture.rsPort}`;
  try {
    const db = getDb();
    const resourceColumn = db.prepare("PRAGMA table_info(tokens)").all() as Array<{ name: string }>;
    assert(
      resourceColumn.some((column) => column.name === "resource"),
      "P2 migration must add tokens.resource"
    );

    const mcpAudience = `${rsUrl}/mcp`;
    assertPermanentRows([fixture.package], {
      kind: "mcp_package",
      packageId: fixture.packageId,
      resource: mcpAudience,
    });
    assertPermanentRows([fixture.client], {
      kind: "client",
      packageId: null,
      resource: mcpAudience,
    });
    assertPermanentRows(fixture.internalChildren, {
      kind: "client",
      packageId: null,
      resource: rsUrl,
    });
    assertPermanentRows([fixture.undecidable], {
      kind: "client",
      packageId: null,
      resource: null,
    });
    assertUndecidableRowsCounted();

    const activeToken = tokenKind === "client" ? fixture.client : fixture.package;
    await replay(rsUrl, activeToken, tokenKind);
    await assertHttpStatus(`${rsUrl}/v1/schema`, activeToken, 401, `${tokenKind} audience at /v1`);

    await replay(rsUrl, fixture.undecidable, "client");
    await assertHttpStatus(
      `${rsUrl}/v1/schema`,
      fixture.undecidable,
      200,
      "undecidable token remains dual-accepted at /v1"
    );

    const [childToken] = fixture.internalChildren;
    assert(childToken, "package fixture needs an internal child token");
    await assertHttpStatus(`${rsUrl}/mcp`, childToken, 401, "internal child token at /mcp");

    if (stage === "P7") {
      db.prepare(
        `UPDATE tokens SET revoked = 1 WHERE token_id IN (${fixture.internalChildren.map(() => "?").join(",")})`
      ).run(...fixture.internalChildren);
      const retired = db
        .prepare(
          `SELECT COUNT(*) AS count FROM tokens
            WHERE token_id IN (${fixture.internalChildren.map(() => "?").join(",")})
              AND revoked = 0`
        )
        .get(...fixture.internalChildren) as { count: number };
      assert.equal(retired.count, 0, "P7 must retire every per-child Core token");
      await replay(rsUrl, fixture.package, "package");
    }
  } finally {
    server.schedulerManager?.stop?.();
    server.asServer.closeAllConnections?.();
    server.rsServer.closeAllConnections?.();
    await Promise.allSettled([
      new Promise<void>((closeResolve) => server.asServer.close(() => closeResolve())),
      new Promise<void>((closeResolve) => server.rsServer.close(() => closeResolve())),
    ]);
    rmSync(scratch, { force: true, recursive: true });
  }
}

for (const tokenKind of ["client", "package"] as const) {
  test(
    `TODO [P2→P3→P7 audience migration] permanent ${tokenKind} token survives the audience boundary`,
    { skip: worktree ? undefined : waiting },
    async () => runPermanentTokenScenario(tokenKind)
  );
}
