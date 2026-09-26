// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import crypto from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { closeDb, getDb, initDb } from "../server/db.ts";
import {
  createOwnerPasswordVerifier,
  OWNER_PASSWORD_MIN_LENGTH,
  ownerPasswordLength,
  verifyOwnerPassword,
} from "../server/owner-password-verifier.ts";
import { closePostgresStorage, initPostgresStorage } from "../server/postgres-storage.ts";
import {
  createOwnerPasswordVerifierStore,
  importLegacyOwnerPasswordFile,
  setOwnerPassword,
} from "../server/stores/owner-password-verifier-store.ts";
import { getOwnerSessionStore } from "../server/stores/owner-session-store.ts";
import { dedicatedPostgresTestUrl } from "./helpers/dedicated-postgres-test-url.ts";
import { withTemporaryPostgresDatabase } from "./helpers/postgres-temp-database.ts";

const TEST_POSTGRES_URL = dedicatedPostgresTestUrl(process.env.PDPP_TEST_POSTGRES_URL);
const MIN_LENGTH_ERROR_PATTERN = /at least 15 characters/u;

async function verifyPasswordRotationFencesSessionIssuance(): Promise<void> {
  const passwordStore = createOwnerPasswordVerifierStore();
  const sessionStore = getOwnerSessionStore();
  const subjectId = "owner-password-race-test";
  await setOwnerPassword(passwordStore, "original owner password");
  const original = await passwordStore.readVersioned();
  assert.ok(original);
  const originalRevision = original.revision;
  const now = Math.floor(Date.now() / 1000);
  const session = (idHash: string) => ({
    exp: now + 3600,
    idHash,
    iat: now,
    publicId: `session-${idHash}`,
    label: "Test browser",
    ipAddress: null,
    userAgent: null,
    deviceKey: idHash,
    lastSeenAt: now,
    revokedAt: null,
    sub: subjectId,
  });

  // Login can verify the old password before the reset starts. If rotation
  // commits before session issuance, the verifier revision fence rejects it.
  const staleLoginSession = session("stale-login");
  const replacementVerifier = await createOwnerPasswordVerifier("replacement owner password");
  assert.equal(await passwordStore.writeAndRevokeAccess(replacementVerifier, subjectId), true);
  assert.equal(await sessionStore.createSession(staleLoginSession, originalRevision), false);
  assert.deepEqual(await sessionStore.listSessions(subjectId, now), []);

  // If login commits first, its session is visible to the same atomic rotation
  // and is revoked before the password change operation returns.
  const current = await passwordStore.readVersioned();
  assert.ok(current);
  const acceptedLoginSession = session("accepted-login");
  assert.equal(await sessionStore.createSession(acceptedLoginSession, current.revision), true);
  const finalVerifier = await createOwnerPasswordVerifier("final owner password");
  assert.equal(await passwordStore.writeAndRevokeAccess(finalVerifier, subjectId, null, current.revision), true);
  assert.deepEqual(await sessionStore.listSessions(subjectId, now), []);
}

test("owner password verifier enforces the minimum and verifies with scrypt", async () => {
  const password = "a long owner password";
  assert.equal(OWNER_PASSWORD_MIN_LENGTH, 15);
  assert.equal(ownerPasswordLength("é".repeat(15)), 15);
  await assert.rejects(createOwnerPasswordVerifier("too short"), MIN_LENGTH_ERROR_PATTERN);

  const first = await createOwnerPasswordVerifier(password);
  const second = await createOwnerPasswordVerifier(password);
  assert.notEqual(first.salt, second.salt, "each verifier has a random salt");
  assert.notEqual(first.hash, password);
  assert.equal(await verifyOwnerPassword(password, first), true);
  assert.equal(await verifyOwnerPassword("a different password", first), false);
});

test("SQLite stores only the verifier and imports the legacy password file once", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pdpp-owner-password-sqlite-"));
  initDb(join(dir, "pdpp.sqlite"));
  try {
    const store = createOwnerPasswordVerifierStore();
    const password = "legacy generated owner password";
    const legacyPath = join(dir, "owner-password");
    await writeFile(legacyPath, `${password}\n`, { mode: 0o600 });

    const imported = await importLegacyOwnerPasswordFile(legacyPath, store, createOwnerPasswordVerifier);
    assert.equal(imported.imported, true);
    assert.ok(imported.verifier);
    assert.equal(await verifyOwnerPassword(password, imported.verifier), true);
    await assert.rejects(readFile(legacyPath), { code: "ENOENT" });

    const row = getDb().prepare("SELECT verifier_json FROM owner_password_verifier WHERE singleton = 1").get() as {
      verifier_json: string;
    };
    assert.doesNotMatch(row.verifier_json, new RegExp(password, "u"));
    assert.deepEqual(await store.read(), imported.verifier);

    const stalePath = join(dir, "stale-owner-password");
    await writeFile(stalePath, "another old password that must not win\n", { mode: 0o600 });
    const secondImport = await importLegacyOwnerPasswordFile(stalePath, store, createOwnerPasswordVerifier);
    assert.equal(secondImport.imported, false);
    assert.deepEqual(secondImport.verifier, imported.verifier);
    await assert.rejects(readFile(stalePath), { code: "ENOENT" });
  } finally {
    closeDb();
    await rm(dir, { force: true, recursive: true });
  }
});

test("SQLite fences owner login session issuance against password rotation", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pdpp-owner-password-race-sqlite-"));
  initDb(join(dir, "pdpp.sqlite"));
  try {
    await verifyPasswordRotationFencesSessionIssuance();
  } finally {
    closeDb();
    await rm(dir, { force: true, recursive: true });
  }
});

test("in-memory SQLite refuses legacy import without consuming the password file", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pdpp-owner-password-memory-"));
  const legacyPath = join(dir, "owner-password");
  const legacyContents = "legacy generated owner password\n";
  initDb(":memory:");
  try {
    await writeFile(legacyPath, legacyContents, { mode: 0o600 });
    const store = createOwnerPasswordVerifierStore();
    const imported = await importLegacyOwnerPasswordFile(legacyPath, store, createOwnerPasswordVerifier);

    assert.deepEqual(imported, { imported: false, verifier: null });
    assert.equal(await readFile(legacyPath, "utf8"), legacyContents);
    assert.equal(await store.read(), null);
  } finally {
    closeDb();
    await rm(dir, { force: true, recursive: true });
  }
});

test("setOwnerPassword persists a salted verifier and accepts 15 characters", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pdpp-owner-password-set-"));
  initDb(join(dir, "pdpp.sqlite"));
  try {
    const store = createOwnerPasswordVerifierStore();
    const password = "123456789012345";
    const verifier = await setOwnerPassword(store, password);
    assert.equal(await verifyOwnerPassword(password, verifier), true);
    assert.equal(await verifyOwnerPassword("123456789012346", verifier), false);
    await assert.rejects(setOwnerPassword(store, "short"), MIN_LENGTH_ERROR_PATTERN);
    const persisted = await store.read();
    assert.deepEqual(persisted, verifier);
  } finally {
    closeDb();
    await rm(dir, { force: true, recursive: true });
  }
});

test("Postgres stores app-managed owner password verifiers", { skip: !TEST_POSTGRES_URL }, async () => {
  assert.ok(TEST_POSTGRES_URL);
  const databaseName = `pdpp_test_owner_password_${crypto.randomBytes(4).toString("hex")}_1`;
  await withTemporaryPostgresDatabase({ connectionString: TEST_POSTGRES_URL, databaseName }, async (databaseUrl) => {
    await initDb(":memory:");
    try {
      await initPostgresStorage({ backend: "postgres", databaseUrl });
      const store = createOwnerPasswordVerifierStore();
      const password = "postgres owner password value";
      const verifier = await setOwnerPassword(store, password);
      assert.equal(await verifyOwnerPassword(password, verifier), true);
      assert.deepEqual(await store.read(), verifier);
    } finally {
      await closePostgresStorage();
      closeDb();
    }
  });
});

test(
  "Postgres fences owner login session issuance against password rotation",
  { skip: !TEST_POSTGRES_URL },
  async () => {
    assert.ok(TEST_POSTGRES_URL);
    const databaseName = `pdpp_test_owner_password_race_${crypto.randomBytes(4).toString("hex")}_1`;
    await withTemporaryPostgresDatabase({ connectionString: TEST_POSTGRES_URL, databaseName }, async (databaseUrl) => {
      await initDb(":memory:");
      try {
        await initPostgresStorage({ backend: "postgres", databaseUrl });
        await verifyPasswordRotationFencesSessionIssuance();
      } finally {
        await closePostgresStorage();
        closeDb();
      }
    });
  }
);
