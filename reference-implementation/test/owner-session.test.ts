// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";

import {
  buildOwnerSessionClearCookie,
  buildOwnerSessionSetCookie,
  createMemoryOwnerSessionStore,
  createOwnerSessionController,
  decodeOwnerSession,
  deriveOwnerSessionSecret,
  encodeOwnerSession,
  OWNER_SESSION_COOKIE_NAME,
  OWNER_SESSION_DEFAULT_TTL_SECONDS,
  parseCookieHeader,
  readOwnerSessionFromCookieHeader,
} from "../server/owner-session.ts";
import { closeDb, initDb } from "../server/db.ts";
import { closePostgresStorage, initPostgresStorage, postgresQuery } from "../server/postgres-storage.ts";
import { getOwnerSessionStore } from "../server/stores/owner-session-store.ts";
import { withTemporaryPostgresDatabase } from "./helpers/postgres-temp-database.ts";
import { dedicatedPostgresTestUrl } from "./helpers/dedicated-postgres-test-url.ts";

const TEST_POSTGRES_URL = dedicatedPostgresTestUrl(process.env.PDPP_TEST_POSTGRES_URL);

test("owner-session default lifetime balances dashboard persistence with finite expiry", () => {
  assert.equal(OWNER_SESSION_DEFAULT_TTL_SECONDS, 7 * 24 * 60 * 60);
});

test("owner-session primitives round-trip signed sessions through cookie headers", () => {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const secret = deriveOwnerSessionSecret("placeholder-test-password");
  const payload = {
    exp: nowSeconds + 1000,
    iat: nowSeconds - 10,
    sub: "owner_local",
  };
  const token = encodeOwnerSession(payload, secret);
  const cookieHeader = `${OWNER_SESSION_COOKIE_NAME}=${encodeURIComponent(token)}; theme=light`;

  assert.deepEqual(parseCookieHeader(cookieHeader), {
    [OWNER_SESSION_COOKIE_NAME]: token,
    theme: "light",
  });
  assert.deepEqual(readOwnerSessionFromCookieHeader(cookieHeader, secret), payload);
  assert.equal(
    decodeOwnerSession(token, secret, { nowSeconds: nowSeconds + 1000 }),
    null,
    "expired tokens are rejected"
  );

  const setCookie = buildOwnerSessionSetCookie(token, {
    maxAgeSeconds: OWNER_SESSION_DEFAULT_TTL_SECONDS,
    secure: true,
  });
  assert.ok(setCookie.startsWith(`${OWNER_SESSION_COOKIE_NAME}=`));
  assert.ok(setCookie.includes("HttpOnly"));
  assert.ok(setCookie.includes("SameSite=Lax"));
  assert.ok(setCookie.includes("Path=/"));
  assert.ok(setCookie.includes("Secure"));
  assert.ok(setCookie.includes(`Max-Age=${OWNER_SESSION_DEFAULT_TTL_SECONDS}`));

  const clearCookie = buildOwnerSessionClearCookie({ secure: true });
  assert.ok(clearCookie.startsWith(`${OWNER_SESSION_COOKIE_NAME}=`));
  assert.ok(clearCookie.includes("Secure"));
  assert.ok(clearCookie.includes("Max-Age=0"));
});

test("owner-session controller preserves the current owner-auth session semantics", async () => {
  const controller = createOwnerSessionController({
    password: "placeholder-test-password",
    sessionStore: createMemoryOwnerSessionStore(),
    subjectId: "owner_testing_custom",
  });

  assert.equal(controller.enabled, true);
  assert.equal(controller.subjectId, "owner_testing_custom");

  const setCookie = await controller.issueSessionCookieHeader({ secure: true });
  assert.ok(setCookie?.includes("HttpOnly"));

  const sessionCookie = setCookie?.split(";")[0] ?? "";
  assert.ok(sessionCookie.startsWith(`${OWNER_SESSION_COOKIE_NAME}=`));

  const session = await controller.readSessionFromCookieHeader(sessionCookie);
  assert.equal(session?.sub, "owner_testing_custom");
  assert.equal(typeof session?.iat, "number");
  assert.equal(typeof session?.exp, "number");

  const cleared = controller.clearSessionCookieHeader({ secure: true });
  assert.ok(cleared.includes("Max-Age=0"));
});

test("owner-session controller issues opaque cookies backed by the server-side store", async () => {
  const store = createMemoryOwnerSessionStore();
  const controller = createOwnerSessionController({
    password: "placeholder-test-password",
    sessionStore: store,
    subjectId: "owner_testing_custom",
  });

  const setCookie = await controller.issueSessionCookieHeader();
  assert.ok(setCookie);
  const cookieValue = setCookie.split(";", 1)[0]?.slice(`${OWNER_SESSION_COOKIE_NAME}=`.length) ?? "";
  assert.ok(cookieValue.length >= 40, "session id has 256 bits of random entropy encoded as base64url");
  assert.equal(cookieValue.includes("."), false, "opaque session ids are not signed JSON payloads");

  const session = await controller.readSessionFromCookieValue(cookieValue);
  assert.equal(session?.sub, "owner_testing_custom");

  assert.equal(await controller.revokeSessionFromCookieValue(cookieValue), true);
  assert.equal(await controller.readSessionFromCookieValue(cookieValue), null, "revoked session is refused");
});

test("Postgres owner-session store supports device replacement, revocation, and bearer inventory", {
  skip: !TEST_POSTGRES_URL,
}, async () => {
  const databaseName = `pdpp_test_owner_session_${crypto.randomBytes(4).toString("hex")}_1`;
  await withTemporaryPostgresDatabase(
    { connectionString: TEST_POSTGRES_URL!, databaseName },
    async (databaseUrl) => {
      await initDb(":memory:");
      try {
        await initPostgresStorage({ backend: "postgres", databaseUrl });
        const subjectId = "owner_postgres_test";
        const controller = createOwnerSessionController({
          password: "postgres-session-test-password",
          sessionStore: getOwnerSessionStore(),
          subjectId,
        });
        const firstCookieHeader = await controller.issueSessionCookieHeader({}, {
          deviceKey: "desktop-shell",
          label: "This computer",
        });
        assert.ok(firstCookieHeader);
        const firstCookie = firstCookieHeader.split(";", 1)[0] ?? "";
        const firstRecord = await controller.readSessionRecordFromCookieHeader(firstCookie);
        assert.ok(firstRecord);

        const replacementCookieHeader = await controller.issueSessionCookieHeader({}, {
          deviceKey: "desktop-shell",
          label: "This computer",
        });
        assert.ok(replacementCookieHeader);
        const replacementCookie = replacementCookieHeader.split(";", 1)[0] ?? "";
        assert.equal(await controller.readSessionRecordFromCookieHeader(firstCookie), null);
        const replacementRecord = await controller.readSessionRecordFromCookieHeader(replacementCookie);
        assert.ok(replacementRecord);
        assert.equal(replacementRecord.label, "This computer");
        assert.equal((await controller.listSessions(subjectId)).length, 1);

        const remoteCookieHeader = await controller.issueSessionCookieHeader({}, {
          deviceKey: "browser-phone",
          label: "Phone browser",
        });
        assert.ok(remoteCookieHeader);
        const remoteCookie = remoteCookieHeader.split(";", 1)[0] ?? "";
        const remoteRecord = await controller.readSessionRecordFromCookieHeader(remoteCookie);
        assert.ok(remoteRecord);
        assert.equal((await controller.listSessions(subjectId)).length, 2);
        assert.equal(await controller.revokeSessionByPublicId(subjectId, remoteRecord.publicId), true);
        assert.equal(await controller.readSessionRecordFromCookieHeader(remoteCookie), null);
        assert.ok(await controller.readSessionRecordFromCookieHeader(replacementCookie));

        const now = new Date().toISOString();
        const bearerSecret = "postgres-owner-bearer-test-secret";
        await postgresQuery(
          `INSERT INTO oauth_clients(client_id, registration_mode, token_endpoint_auth_method, metadata_json, created_at, updated_at)
           VALUES($1, 'dynamic', 'none', $2::jsonb, $3, $3)`,
          ["owner-session-postgres-test-client", JSON.stringify({ client_name: "Postgres test client" }), now]
        );
        await postgresQuery(
          `INSERT INTO tokens(token_id, subject_id, client_id, token_kind, expires_at, created_at)
           VALUES($1, $2, $3, 'owner', $4, $5)`,
          [bearerSecret, subjectId, "owner-session-postgres-test-client", new Date(Date.now() + 60_000).toISOString(), now]
        );
        const bearers = await controller.listOwnerBearers(subjectId);
        assert.equal(bearers.length, 1);
        assert.equal(bearers[0]?.label, "Postgres test client");
        assert.match(bearers[0]?.id ?? "", /^tok_[A-Za-z0-9_-]{43}$/u);
        assert.doesNotMatch(JSON.stringify(bearers), new RegExp(bearerSecret, "u"));
        assert.equal(await controller.revokeOwnerBearer(subjectId, bearers[0]!.id), true);
        const revoked = await postgresQuery<{ revoked: boolean }>(
          "SELECT revoked FROM tokens WHERE token_id = $1",
          [bearerSecret]
        );
        assert.equal(revoked.rows[0]?.revoked, true);
      } finally {
        await closePostgresStorage();
        closeDb();
      }
    }
  );
});

test("deriveOwnerSessionSecret uses scrypt KDF (not fast SHA-256)", () => {
  // Verify the returned buffer is 32 bytes — scrypt output length.
  const secret = deriveOwnerSessionSecret("some-test-password");
  assert.equal(secret.length, 32, "derived secret must be 32 bytes (scrypt output)");

  // Verify that the same password always yields the same key (deterministic).
  const secret2 = deriveOwnerSessionSecret("some-test-password");
  assert.deepEqual(secret, secret2, "same password must yield same secret");

  // Verify that a different password yields a different key.
  const other = deriveOwnerSessionSecret("different-password");
  assert.notDeepEqual(secret, other, "different password must yield different secret");

  // Verify the output is NOT the raw SHA-256 of the old derivation, so we
  // can be certain we are not running the old fast path.
  const oldDerivation = crypto.createHash("sha256").update("pdpp-owner-session:some-test-password").digest();
  assert.notDeepEqual(secret, oldDerivation, "new derivation must differ from single-round SHA-256");
});

test("deriveOwnerSessionSecret wrong password produces different secret (sign/verify fails)", () => {
  const secretCorrect = deriveOwnerSessionSecret("correct-password");
  const secretWrong = deriveOwnerSessionSecret("wrong-password");

  const nowSeconds = Math.floor(Date.now() / 1000);
  const payload = { exp: nowSeconds + 3600, iat: nowSeconds - 5, sub: "owner_local" };
  const token = encodeOwnerSession(payload, secretCorrect);

  // Token signed with correct secret must verify.
  assert.deepEqual(decodeOwnerSession(token, secretCorrect), payload);
  // Same token presented with a wrong secret must be rejected.
  assert.equal(decodeOwnerSession(token, secretWrong), null, "wrong password must fail verification");
});

test("owner-session package export is available via the workspace package name", async () => {
  const ownerSession = await import("pdpp-reference-implementation/owner-session");

  assert.equal(ownerSession.OWNER_SESSION_COOKIE_NAME, OWNER_SESSION_COOKIE_NAME);
  assert.equal(typeof ownerSession.createMemoryOwnerSessionStore, "function");
  assert.equal(typeof ownerSession.createOwnerSessionController, "function");
});
