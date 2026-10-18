// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Process-kill tests for the revocation cascades.
 *
 * `markPackageRevokedCascade` (package row, package tokens, member rows,
 * refresh tokens) and `revokeGrantStorage` (grant row, tokens, refresh
 * tokens) used to run their statements one by one, each in its own commit.
 * A kill between two of them left a row that says "revoked" with live rows
 * beneath it. The owner revoke route refuses a package whose persisted
 * status is not 'active' (server/routes/ref-grants.ts), so nothing retried
 * the half-finished cascade.
 *
 * Each scenario runs the real revocation in a child process, SIGKILLs it
 * after the status row and before the rest, reopens the same storage
 * (SQLite file or private Postgres database) and asserts that a revoked row
 * has nothing live under it, and that a retry reaches the fully revoked
 * state. SIGKILL keeps the kernel page cache: this proves recovery from a
 * process crash, not fsync or power-loss durability.
 */

import assert from "node:assert/strict";

import {
  exchangeOAuthAuthorizationCode,
  exchangeOAuthRefreshToken,
  getGrantPackageForOwner,
  issueOAuthAuthorizationCodeForDeviceCode,
  revokeGrant,
  revokeGrantPackage,
} from "../server/auth.ts";
import { closePostgresStorage } from "../server/postgres-storage.ts";
import {
  approveAndStageOAuthRequest,
  count,
  isActive,
  OAUTH_CLIENT_ID,
  OAUTH_REDIRECT_URI,
  rows,
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

scenario(
  "grant revocation killed after the grant row never leaves a revoked grant with a live token or refresh token",
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
    await killAt(spec, "grant-revoke:after-status-update", "revoke-grant", {
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
