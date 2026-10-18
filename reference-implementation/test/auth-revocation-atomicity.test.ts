// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Process-kill tests for the revocation cascades.
 *
 * `markPackageRevokedCascade` and `revokeGrantStorage` used to run their
 * statements one by one, each in its own commit.
 * A kill between two of them left a row that says "revoked" with live rows
 * beneath it. The owner revoke route refuses a package whose persisted
 * status is not 'active' (server/routes/ref-grants.ts), so nothing retried
 * the half-finished cascade.
 *
 * Each scenario runs the real revocation in a child process, SIGKILLs it
 * after the refresh rows and before the remaining dependent and parent
 * rows, reopens the same storage
 * (SQLite file or private Postgres database) and asserts that a revoked row
 * has nothing live under it, and that a retry reaches the fully revoked
 * state. SIGKILL keeps the kernel page cache: this proves recovery from a
 * process crash, not fsync or power-loss durability.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout } from "node:timers/promises";
import pg from "pg";

import {
  exchangeOAuthAuthorizationCode,
  exchangeOAuthRefreshToken,
  getGrantPackageForOwner,
  issueOAuthAuthorizationCodeForDeviceCode,
  revokeGrant,
  revokeGrantPackage,
} from "../server/auth.ts";
import { closePostgresStorage, postgresQuery } from "../server/postgres-storage.ts";
import {
  approveAndStageOAuthRequest,
  closeStorage,
  count,
  isActive,
  OAUTH_CLIENT_ID,
  OAUTH_REDIRECT_URI,
  openStorage,
  rows,
  seedBase,
} from "./helpers/auth-kill-fixture.ts";
import {
  assertPackageFullyRevoked,
  assertRevokedPackageIsComplete,
  createScenario,
  killAt,
  killRevocationAt,
  packageLayer,
  packageWithRefreshToken,
  truthy,
} from "./helpers/auth-kill-scenarios.ts";
import { dedicatedPostgresTestUrl } from "./helpers/dedicated-postgres-test-url.ts";
import { withTemporaryPostgresDatabase } from "./helpers/postgres-temp-database.ts";

const POSTGRES_URL = dedicatedPostgresTestUrl(process.env.PDPP_TEST_POSTGRES_URL);

const scenario = createScenario({
  postgres: POSTGRES_URL
    ? (databaseName, run) =>
        withTemporaryPostgresDatabase(
          {
            closeConnections: closePostgresStorage,
            connectionString: POSTGRES_URL,
            databaseName,
          },
          run
        )
    : null,
});

scenario(
  "package revocation killed inside the cascade never leaves a revoked package with live rows beneath it",
  async (spec) => {
    const pkg = await packageWithRefreshToken(spec);
    await killRevocationAt(spec, pkg, "package-revoke:in-cascade", 1);

    // The package row and everything under it commit together or not at all.
    const layer = await packageLayer(spec, pkg.packageId);
    assertRevokedPackageIsComplete(layer, "after the kill");
    const detail = await getGrantPackageForOwner(pkg.packageId);
    assert.ok(detail);
    assert.equal(detail.persisted_status, layer.packageStatus, "the owner route reads the same persisted status");

    // A restart plus a retry of the revocation reaches the full revoked state.
    await revokeGrantPackage(pkg.packageId);
    await assertPackageFullyRevoked(spec, pkg, "after retry");
  }
);

for (const kind of ["grant", "package"] as const) {
  test(`Postgres ${kind} revoke waits for the refresh row before locking the parent`, {
    skip: POSTGRES_URL ? false : "PDPP_TEST_POSTGRES_URL unset",
  }, async () => {
    assert.ok(POSTGRES_URL);
    await withTemporaryPostgresDatabase(
      {
        closeConnections: closePostgresStorage,
        connectionString: POSTGRES_URL,
        databaseName: `pdpp_test_revoke_lock_${kind}_${process.pid}`,
      },
      async (pgUrl) => {
        const spec = { backend: "postgres" as const, pgUrl, sqlitePath: ":memory:" };
        await openStorage(spec);
        const holder = new pg.Client({ connectionString: pgUrl });
        let revoking: Promise<unknown> | undefined;
        try {
          await seedBase();
          let id: string;
          if (kind === "package") {
            id = (await packageWithRefreshToken(spec)).packageId;
          } else {
            const approved = await approveAndStageOAuthRequest(spec);
            const delivery = await issueOAuthAuthorizationCodeForDeviceCode(approved.deviceCode, approved);
            await exchangeOAuthAuthorizationCode({
              clientId: OAUTH_CLIENT_ID,
              code: delivery?.code,
              codeVerifier: approved.pkce.verifier,
              redirectUri: OAUTH_REDIRECT_URI,
            });
            id = approved.grantId;
          }
          const column = kind === "grant" ? "grant_id" : "package_id";
          const table = kind === "grant" ? "grants" : "grant_packages";
          const refresh = await postgresQuery<{ refresh_token_hash: string }>(
            `SELECT refresh_token_hash FROM oauth_refresh_tokens WHERE ${column} = $1`,
            [id]
          );
          assert.equal(refresh.rows.length, 1, "premise: one refresh row");
          await holder.connect();
          await holder.query("BEGIN");
          const [backend] = (await holder.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows;
          assert.ok(backend);
          const { pid } = backend;
          const [refreshRow] = refresh.rows;
          assert.ok(refreshRow);
          // The refresh path locks this exact row before it locks its parent.
          await holder.query("SELECT * FROM oauth_refresh_tokens WHERE refresh_token_hash = $1 FOR UPDATE", [
            refreshRow.refresh_token_hash,
          ]);
          revoking = kind === "grant" ? revokeGrant(id) : revokeGrantPackage(id);
          // Attach a handler immediately; the result is still checked below.
          revoking.catch(() => undefined);
          let blocked = false;
          const deadline = Date.now() + 10_000;
          while (!blocked && Date.now() < deadline) {
            // biome-ignore lint/performance/noAwaitInLoops: Poll until the database observes the blocked revoke.
            const observation = await postgresQuery<{ blocked: boolean }>(
              "SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))) AS blocked",
              [pid]
            );
            const [observed] = observation.rows;
            assert.ok(observed);
            ({ blocked } = observed);
            if (!blocked) {
              await setTimeout(10);
            }
          }
          assert.ok(blocked, "revoke must wait on the held refresh row");
          await assert.doesNotReject(
            () => holder.query(`SELECT 1 FROM ${table} WHERE ${column} = $1 FOR UPDATE NOWAIT`, [id]),
            "dependent rows first: revoke must not hold the parent while waiting for refresh"
          );
          await holder.query("COMMIT");
          await revoking;
          const parent = await postgresQuery<{ status: string }>(`SELECT status FROM ${table} WHERE ${column} = $1`, [
            id,
          ]);
          assert.equal(parent.rows[0]?.status, "revoked", "revoke completes after refresh releases its lock");
        } finally {
          await holder.query("ROLLBACK").catch(() => undefined);
          await holder.end();
          await revoking?.catch(() => undefined);
          await closeStorage(spec);
        }
      }
    );
  });
}

scenario(
  "grant revocation killed inside the cascade never leaves a revoked grant with a live token or refresh token",
  async (spec) => {
    const approved = await approveAndStageOAuthRequest(spec);
    const delivery = await issueOAuthAuthorizationCodeForDeviceCode(approved.deviceCode, {
      grantId: approved.grantId,
      token: approved.token,
    });
    const exchanged = await exchangeOAuthAuthorizationCode({
      clientId: OAUTH_CLIENT_ID,
      code: delivery?.code,
      codeVerifier: approved.pkce.verifier,
      redirectUri: OAUTH_REDIRECT_URI,
    });
    assert.equal(typeof exchanged.refresh_token, "string");
    await killAt(spec, "grant-revoke:in-cascade", "revoke-grant", {
      grantId: approved.grantId,
    });

    const [grant] = await rows<{ status: string }>(spec, "SELECT status FROM grants WHERE grant_id = ?", [
      approved.grantId,
    ]);
    const [token] = await rows<{ revoked: unknown }>(spec, "SELECT revoked FROM tokens WHERE token_id = ?", [
      approved.token,
    ]);
    const refresh = await rows<{ status: string }>(spec, "SELECT status FROM oauth_refresh_tokens WHERE grant_id = ?", [
      approved.grantId,
    ]);
    if (grant?.status === "revoked") {
      assert.equal(truthy(token?.revoked), true, "a revoked grant must not keep a live token row");
      assert.deepEqual(
        refresh.map((row) => row.status),
        ["revoked"],
        "a revoked grant must not keep a live refresh token"
      );
    }
    assert.equal(
      await isActive(approved.token),
      grant?.status !== "revoked",
      "introspection agrees with the persisted grant status"
    );

    // A retry reaches the fully revoked state.
    await revokeGrant(approved.grantId);
    assert.equal(await isActive(approved.token), false);
    await assert.rejects(() =>
      exchangeOAuthRefreshToken({
        clientId: OAUTH_CLIENT_ID,
        refreshToken: exchanged.refresh_token,
      })
    );
    assert.equal(
      await count(spec, "SELECT COUNT(*) AS n FROM oauth_refresh_tokens WHERE grant_id = ? AND status = 'active'", [
        approved.grantId,
      ]),
      0
    );
  }
);
