// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Auth scenario runner and revocation assertions shared by the auth
 * kill-boundary test files (test/auth-kill-boundaries.test.ts and
 * test/auth-revocation-atomicity.test.ts). This is not a second crash harness:
 * the process-kill primitives live in test/helpers/crash-harness.ts, and this
 * file only seeds auth storage and drives them.
 *
 * A scenario gets fresh seeded storage (a temp SQLite file or a temp Postgres
 * database), runs, and tears down. `killAt` closes this process's storage,
 * runs the crash child to a named crash point, SIGKILLs it there and reopens
 * the storage, which is what a restarted server does first.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  exchangeOAuthAuthorizationCode,
  exchangeOAuthRefreshToken,
  getGrantPackageAccess,
  issueOAuthAuthorizationCodeForPackageDeviceCode,
  stageOAuthAuthorizationCodeRequest,
} from "../../server/auth.ts";
import {
  type Backend,
  closeStorage,
  count,
  createPackage,
  isActive,
  newPkce,
  OAUTH_CLIENT_ID,
  OAUTH_REDIRECT_URI,
  openStorage,
  rows,
  type StorageSpec,
  seedBase,
} from "./auth-kill-fixture.ts";
import { killChildAt, spawnCrashChild } from "./crash-harness.ts";

export const AUTH_KILL_CHILD = join(import.meta.dirname, "../fixtures/crash/auth-kill-child.ts");
export const BACKENDS: readonly Backend[] = ["sqlite", "postgres"];

/** How a test file provisions a scratch Postgres database. The file owns this so it can be triaged for template eligibility. */
export type PostgresDatabaseProvider = (
  databaseName: string,
  run: (pgUrl: string) => Promise<void>
) => Promise<unknown>;

export function childArgs(spec: StorageSpec, op: string, input: unknown): string[] {
  return [JSON.stringify(spec), op, JSON.stringify(input)];
}

/** Close storage, run the child to `point`, SIGKILL it there, reopen storage. */
export async function killAt(spec: StorageSpec, point: string, op: string, input: unknown): Promise<void> {
  await closeStorage(spec);
  await killChildAt(AUTH_KILL_CHILD, point, {
    args: childArgs(spec, op, input),
  });
  await openStorage(spec);
}

export function createScenario(options: { postgres: PostgresDatabaseProvider | null }) {
  let databaseCounter = 0;
  const withStorage = async (backend: Backend, run: (spec: StorageSpec) => Promise<void>): Promise<void> => {
    const dir = mkdtempSync(join(tmpdir(), "pdpp-auth-kill-"));
    const sqlitePath = join(dir, "auth.sqlite");
    const body = async (spec: StorageSpec): Promise<void> => {
      await openStorage(spec);
      try {
        await seedBase();
        await run(spec);
      } finally {
        await closeStorage(spec);
      }
    };
    try {
      if (backend === "sqlite") {
        await body({ backend, sqlitePath });
        return;
      }
      databaseCounter += 1;
      await (options.postgres as PostgresDatabaseProvider)(
        `pdpp_test_auth_kill_${process.pid}_${databaseCounter}`,
        (pgUrl) => body({ backend, pgUrl, sqlitePath })
      );
    } finally {
      rmSync(dir, { force: true, recursive: true });
    }
  };
  return (name: string, run: (spec: StorageSpec) => Promise<void>): void => {
    for (const backend of BACKENDS) {
      test(
        `${name} [${backend}]`,
        {
          skip: backend === "postgres" && !options.postgres ? "PDPP_TEST_POSTGRES_URL unset" : false,
        },
        () => withStorage(backend, run)
      );
    }
  };
}

export const truthy = (value: unknown): boolean => value === true || value === 1 || value === "1" || value === "t";

export async function eventCount(spec: StorageSpec): Promise<number> {
  return await count(spec, "SELECT COUNT(*) AS n FROM spine_events");
}

// ─── Revocation ────────────────────────────────────────────────────────────

export interface Layer {
  /** Member grant status keyed by the member's access token id. */
  readonly grantStatusByToken: Readonly<Record<string, string>>;
  readonly memberStatuses: readonly string[];
  readonly packageStatus: string | undefined;
  readonly refreshStatuses: readonly string[];
  readonly tokenRevoked: readonly boolean[];
}

export async function packageLayer(spec: StorageSpec, packageId: string): Promise<Layer> {
  const pkg = await rows<{ status: string }>(spec, "SELECT status FROM grant_packages WHERE package_id = ?", [
    packageId,
  ]);
  const members = await rows<{
    grant_status: string;
    status: string;
    token_id: string;
  }>(
    spec,
    `SELECT m.status, m.token_id, g.status AS grant_status
       FROM grant_package_members m JOIN grants g ON g.grant_id = m.grant_id
      WHERE m.package_id = ? ORDER BY m.grant_id`,
    [packageId]
  );
  const tokens = await rows<{ revoked: unknown }>(
    spec,
    `SELECT t.revoked FROM tokens t WHERE t.package_id = ?
      UNION ALL
     SELECT t.revoked FROM tokens t JOIN grant_package_members m ON m.token_id = t.token_id WHERE m.package_id = ?`,
    [packageId, packageId]
  );
  const refresh = await rows<{ status: string }>(spec, "SELECT status FROM oauth_refresh_tokens WHERE package_id = ?", [
    packageId,
  ]);
  return {
    grantStatusByToken: Object.fromEntries(members.map((row) => [row.token_id, row.grant_status])),
    memberStatuses: members.map((row) => row.status),
    packageStatus: pkg[0]?.status,
    refreshStatuses: refresh.map((row) => row.status),
    tokenRevoked: tokens.map((row) => truthy(row.revoked)),
  };
}

/** A package whose row says 'revoked' must have nothing live beneath it, whatever the kill interrupted. */
export function assertRevokedPackageIsComplete(layer: Layer, where: string): void {
  if (layer.packageStatus !== "revoked") return;
  assert.deepEqual([...new Set(Object.values(layer.grantStatusByToken))], ["revoked"], `${where}: every member grant`);
  assert.deepEqual([...new Set(layer.memberStatuses)], ["revoked"], `${where}: every member row`);
  assert.deepEqual([...new Set(layer.tokenRevoked)], [true], `${where}: every package and member token is revoked`);
  assert.deepEqual(
    layer.refreshStatuses.filter((status) => status !== "revoked"),
    [],
    `${where}: every refresh token`
  );
}

export interface PackageUnderRevocation {
  readonly childGrantIds: readonly string[];
  readonly childTokens: readonly string[];
  readonly packageId: string;
  readonly packageToken: string;
  readonly refreshToken: string;
}

/** A 3-member package whose package token also carries a live refresh token (a real OAuth issuance). */
export async function packageWithRefreshToken(spec: StorageSpec): Promise<PackageUnderRevocation> {
  const created = await createPackage(spec, 3);
  const deviceCode = `dev_pkg_${created.packageId}`;
  const pkce = newPkce();
  await stageOAuthAuthorizationCodeRequest({
    clientId: OAUTH_CLIENT_ID,
    codeChallenge: pkce.challenge,
    codeChallengeMethod: "S256",
    deviceCode,
    redirectUri: OAUTH_REDIRECT_URI,
  });
  const delivery = await issueOAuthAuthorizationCodeForPackageDeviceCode(deviceCode, {
    packageId: created.packageId,
    token: created.packageToken,
  });
  const exchanged = await exchangeOAuthAuthorizationCode({
    clientId: OAUTH_CLIENT_ID,
    code: delivery?.code,
    codeVerifier: pkce.verifier,
    redirectUri: OAUTH_REDIRECT_URI,
  });
  assert.equal(typeof exchanged.refresh_token, "string", "premise: the package token carries a refresh token");
  return { ...created, refreshToken: exchanged.refresh_token as string };
}

export async function assertPackageFullyRevoked(
  spec: StorageSpec,
  pkg: PackageUnderRevocation,
  where: string
): Promise<void> {
  const layer = await packageLayer(spec, pkg.packageId);
  assert.equal(layer.packageStatus, "revoked", `${where}: package row`);
  assertRevokedPackageIsComplete(layer, where);
  assert.equal(await isActive(pkg.packageToken), false, `${where}: package token introspects inactive`);
  for (const token of pkg.childTokens) {
    assert.equal(await isActive(token), false, `${where}: member token introspects inactive`);
  }
  assert.equal(await getGrantPackageAccess(pkg.packageId), null, `${where}: no read authority remains`);
  await assert.rejects(
    () =>
      exchangeOAuthRefreshToken({
        clientId: OAUTH_CLIENT_ID,
        refreshToken: pkg.refreshToken,
      }),
    `${where}: the refresh token cannot mint access`
  );
}

/** Kill `revoke-package` at the `hit`-th arrival at `point` (1 = first). */
export async function killRevocationAt(
  spec: StorageSpec,
  pkg: PackageUnderRevocation,
  point: string,
  hit: 1 | 2
): Promise<void> {
  await closeStorage(spec);
  const child = spawnCrashChild(AUTH_KILL_CHILD, {
    args: childArgs(spec, "revoke-package", { packageId: pkg.packageId }),
    points: [point],
  });
  await child.parked(point);
  if (hit === 2) {
    child.resume();
    await child.parked(point);
  }
  const exit = await child.kill();
  assert.equal(exit.signal, "SIGKILL");
  await openStorage(spec);
}
