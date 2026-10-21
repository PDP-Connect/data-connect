// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import test from "node:test";

import {
  issueOAuthAuthorizationCodeForDeviceCode,
  issueOAuthAuthorizationCodeForPackageDeviceCode,
  stageOAuthAuthorizationCodeRequest,
} from "../server/auth.ts";
import { closeDb, getDb, initDb } from "../server/db.ts";
import { closePostgresStorage, initPostgresStorage, postgresQuery } from "../server/postgres-storage.ts";
import { dedicatedPostgresTestUrl } from "./helpers/dedicated-postgres-test-url.ts";
import { withTemporaryPostgresDatabase } from "./helpers/postgres-temp-database.ts";

const POSTGRES_URL = dedicatedPostgresTestUrl(process.env.PDPP_TEST_POSTGRES_URL);
const NOT_RECOVERABLE = /not recoverable/;

type Backend = "postgres" | "sqlite";

async function markCodeConsumed(backend: Backend, code: string): Promise<void> {
  if (backend === "postgres") {
    await postgresQuery(
      "UPDATE oauth_authorization_codes SET status = 'consumed', consumed_at = NOW() WHERE code = $1",
      [code]
    );
    return;
  }
  getDb()
    .prepare("UPDATE oauth_authorization_codes SET status = 'consumed', consumed_at = datetime('now') WHERE code = ?")
    .run(code);
}

async function expireIssuedCode(backend: Backend, deviceCode: string): Promise<void> {
  const expiresAt = new Date(Date.now() - 60_000).toISOString();
  if (backend === "postgres") {
    await postgresQuery("UPDATE oauth_authorization_codes SET expires_at = $1 WHERE device_code = $2", [
      expiresAt,
      deviceCode,
    ]);
    return;
  }
  getDb()
    .prepare("UPDATE oauth_authorization_codes SET expires_at = ? WHERE device_code = ?")
    .run(expiresAt, deviceCode);
}

async function countIssuedRows(backend: Backend, deviceCode: string): Promise<number> {
  if (backend === "postgres") {
    const result = await postgresQuery<{ count: number }>(
      "SELECT COUNT(*)::int AS count FROM oauth_authorization_codes WHERE device_code = $1",
      [deviceCode]
    );
    return result.rows[0]?.count ?? 0;
  }
  return (
    getDb()
      .prepare("SELECT COUNT(*) AS count FROM oauth_authorization_codes WHERE device_code = ?")
      .get(deviceCode) as {
      count: number;
    }
  ).count;
}

async function exerciseDelivery(backend: Backend): Promise<void> {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const clientId = `client_${backend}_${randomBytes(6).toString("hex")}`;
  const redirectUri = `https://${backend}.client.example/callback`;
  const stage = async (deviceCode: string) => {
    await stageOAuthAuthorizationCodeRequest({
      clientId,
      codeChallenge: challenge,
      codeChallengeMethod: "S256",
      deviceCode,
      redirectUri,
      state: "delivery-state",
    });
  };

  const grantDeviceCode = `device_grant_${backend}_${randomBytes(6).toString("hex")}`;
  await stage(grantDeviceCode);
  const grantBinding = { grantId: `grt_${backend}`, token: `tok_${backend}` };
  const grantResults = await Promise.all([
    issueOAuthAuthorizationCodeForDeviceCode(grantDeviceCode, grantBinding),
    issueOAuthAuthorizationCodeForDeviceCode(grantDeviceCode, grantBinding),
  ]);
  assert.deepEqual(grantResults[1], grantResults[0], "concurrent delivery must converge on the persisted code");
  assert.equal(grantResults[0]?.redirect_uri, redirectUri);
  assert.equal(typeof grantResults[0]?.code, "string");
  assert.equal(await countIssuedRows(backend, grantDeviceCode), 1);
  await assert.rejects(
    () => issueOAuthAuthorizationCodeForDeviceCode(grantDeviceCode, { ...grantBinding, token: "tok_mismatch" }),
    NOT_RECOVERABLE
  );
  await markCodeConsumed(backend, String(grantResults[0]?.code));
  await assert.rejects(() => issueOAuthAuthorizationCodeForDeviceCode(grantDeviceCode, grantBinding), NOT_RECOVERABLE);

  const packageDeviceCode = `device_package_${backend}_${randomBytes(6).toString("hex")}`;
  await stage(packageDeviceCode);
  const packageBinding = { packageId: `gpkg_${backend}`, token: `tok_pkg_${backend}` };
  const packageResults = await Promise.all([
    issueOAuthAuthorizationCodeForPackageDeviceCode(packageDeviceCode, packageBinding),
    issueOAuthAuthorizationCodeForPackageDeviceCode(packageDeviceCode, packageBinding),
  ]);
  assert.deepEqual(packageResults[1], packageResults[0], "package delivery retry must return the persisted code");
  assert.equal(packageResults[0]?.redirect_uri, redirectUri);
  assert.equal(typeof packageResults[0]?.code, "string");
  assert.equal(await countIssuedRows(backend, packageDeviceCode), 1);
  await assert.rejects(
    () =>
      issueOAuthAuthorizationCodeForPackageDeviceCode(packageDeviceCode, {
        ...packageBinding,
        packageId: "gpkg_mismatch",
      }),
    NOT_RECOVERABLE
  );

  const expiredDeviceCode = `device_expired_${backend}_${randomBytes(6).toString("hex")}`;
  await stage(expiredDeviceCode);
  const expiredBinding = { grantId: `grt_expired_${backend}`, token: `tok_expired_${backend}` };
  const expiredDelivery = await issueOAuthAuthorizationCodeForDeviceCode(expiredDeviceCode, expiredBinding);
  assert.equal(typeof expiredDelivery?.code, "string");
  await expireIssuedCode(backend, expiredDeviceCode);
  const expiredRows =
    backend === "postgres"
      ? (
          await postgresQuery<{ expires_at: string }>(
            "SELECT expires_at FROM oauth_authorization_codes WHERE device_code = $1",
            [expiredDeviceCode]
          )
        ).rows
      : [
          getDb()
            .prepare("SELECT expires_at FROM oauth_authorization_codes WHERE device_code = ?")
            .get(expiredDeviceCode) as { expires_at: string },
        ];
  assert.ok(Date.parse(String(expiredRows[0]?.expires_at)) < Date.now(), "seeded issued code must be expired");
  await assert.rejects(
    () => issueOAuthAuthorizationCodeForDeviceCode(expiredDeviceCode, expiredBinding),
    NOT_RECOVERABLE
  );
  assert.equal(await countIssuedRows(backend, expiredDeviceCode), 1, "expired delivery must not be replaced");
}

test("SQLite authorization-code delivery is CAS-bound and recoverable", async () => {
  initDb(":memory:");
  try {
    await exerciseDelivery("sqlite");
  } finally {
    closeDb();
  }
});

test("PostgreSQL authorization-code delivery is CAS-bound and recoverable", {
  skip: POSTGRES_URL ? false : "PDPP_TEST_POSTGRES_URL unset",
}, async () => {
  assert.ok(POSTGRES_URL);
  await withTemporaryPostgresDatabase(
    {
      closeConnections: closePostgresStorage,
      connectionString: POSTGRES_URL,
      databaseName: "pdpp_test_oauth_code_delivery",
    },
    async (databaseUrl) => {
      await initPostgresStorage({ backend: "postgres", databaseUrl });
      await exerciseDelivery("postgres");
    }
  );
});

async function readAuthorizationCodeRow(backend: Backend, deviceCode: string): Promise<Record<string, unknown>> {
  if (backend === "postgres") {
    const result = await postgresQuery<Record<string, unknown>>(
      "SELECT * FROM oauth_authorization_codes WHERE device_code = $1",
      [deviceCode]
    );
    assert.ok(result.rows[0]);
    return result.rows[0];
  }
  const row = getDb()
    .prepare("SELECT * FROM oauth_authorization_codes WHERE device_code = ?")
    .get(deviceCode) as Record<string, unknown> | undefined;
  assert.ok(row);
  return { ...row };
}

type RestageStatus = "pending" | "expired" | "issued" | "consumed";

async function exerciseRestaging(backend: Backend, status: RestageStatus): Promise<void> {
  const deviceCode = `device_restage_${backend}_${randomBytes(6).toString("hex")}`;
  const request = {
    clientId: `client_restage_${backend}`,
    codeChallenge: createHash("sha256").update(randomBytes(32)).digest("base64url"),
    codeChallengeMethod: "S256",
    deviceCode,
    redirectUri: `https://${backend}.client.example/callback`,
    state: "original-state",
  };
  await stageOAuthAuthorizationCodeRequest(request);
  if (status === "issued" || status === "consumed") {
    const delivery = await issueOAuthAuthorizationCodeForDeviceCode(deviceCode, {
      grantId: `grt_restage_${backend}`,
      token: `tok_restage_${backend}`,
    });
    assert.equal(typeof delivery?.code, "string");
    if (status === "consumed") {
      await markCodeConsumed(backend, String(delivery?.code));
    }
  } else if (status === "expired") {
    if (backend === "postgres") {
      await postgresQuery("UPDATE oauth_authorization_codes SET status = 'expired' WHERE device_code = $1", [
        deviceCode,
      ]);
    } else {
      getDb().prepare("UPDATE oauth_authorization_codes SET status = 'expired' WHERE device_code = ?").run(deviceCode);
    }
  }

  const before = await readAuthorizationCodeRow(backend, deviceCode);
  assert.equal(before.status, status);
  const restage = () => stageOAuthAuthorizationCodeRequest({ ...request, state: "replacement-state" });
  if (status === "issued" || status === "consumed") {
    assert.ok(before.code);
    assert.ok(before.issued_at);
    if (status === "consumed") {
      assert.ok(before.consumed_at);
    }
    await assert.rejects(restage, /already issued or consumed.*cannot be restaged/);
    assert.deepEqual(
      await readAuthorizationCodeRow(backend, deviceCode),
      before,
      "terminal restaging must preserve the complete row, including code, bindings and timestamps"
    );
    assert.equal(await countIssuedRows(backend, deviceCode), 1);
  } else {
    const staged = await restage();
    const after = await readAuthorizationCodeRow(backend, deviceCode);
    assert.equal(staged.status, "pending");
    assert.equal(after.status, "pending");
    assert.equal(after.state, "replacement-state");
    assert.equal(after.id, before.id);
    assert.equal(after.code, null);
    assert.equal(await countIssuedRows(backend, deviceCode), 1);
  }
}

// DCR-29: terminal OAuth requests are immutable; nonterminal restaging remains supported.
for (const status of ["issued", "consumed", "pending", "expired"] as const) {
  test(`SQLite OAuth request restaging: ${status}`, async () => {
    initDb(":memory:");
    try {
      await exerciseRestaging("sqlite", status);
    } finally {
      closeDb();
    }
  });

  test(
    `PostgreSQL OAuth request restaging: ${status}${POSTGRES_URL ? "" : " (skipped: PDPP_TEST_POSTGRES_URL unset)"}`,
    { skip: !POSTGRES_URL },
    async () => {
      assert.ok(POSTGRES_URL);
      await withTemporaryPostgresDatabase(
        {
          closeConnections: closePostgresStorage,
          connectionString: POSTGRES_URL,
          databaseName: "pdpp_test_oauth_code_restage",
        },
        async (databaseUrl) => {
          await initPostgresStorage({ backend: "postgres", databaseUrl });
          await exerciseRestaging("postgres", status);
        }
      );
    }
  );
}
