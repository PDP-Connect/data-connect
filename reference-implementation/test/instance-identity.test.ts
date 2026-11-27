// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import crypto from "node:crypto";
import { mkdtemp, rm, stat, writeFile, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  INSTANCE_IDENTITY_FILE,
  instanceFingerprint,
  instanceProofMessage,
  loadOrCreateInstanceIdentity,
} from "../server/instance-identity.ts";

function spkiFromRaw(raw: Buffer): crypto.KeyObject {
  const prefix = Buffer.from("302a300506032b6570032100", "hex");
  return crypto.createPublicKey({ key: Buffer.concat([prefix, raw]), format: "der", type: "spki" });
}

async function withDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "pdpp-instance-identity-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
}

test("instance fingerprint matches the contract test vector", () => {
  const raw = Buffer.from(Array.from({ length: 32 }, (_, i) => i));
  assert.equal(raw.toString("base64url"), "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8");
  assert.equal(instanceFingerprint(raw), "MMG4-2KLG-YQZW-NEIS");
});

test("instance identity: created once, 0600, and the same after a re-load", async () => {
  await withDir(async (dir) => {
    const first = loadOrCreateInstanceIdentity(join(dir, "nested"));
    const file = join(dir, "nested", INSTANCE_IDENTITY_FILE);
    assert.equal((await stat(file)).mode & 0o777, 0o600);
    const bytes = await readFile(file, "utf8");
    const second = loadOrCreateInstanceIdentity(join(dir, "nested"));
    assert.equal(second.publicKey, first.publicKey);
    assert.equal(second.fingerprint, first.fingerprint);
    assert.equal(await readFile(file, "utf8"), bytes, "a parseable file is never rewritten");
    assert.deepEqual(await readdir(join(dir, "nested")), [INSTANCE_IDENTITY_FILE], "no temp file is left behind");
  });
});

test("instance identity: public key is 43 base64url characters and the fingerprint has four groups", async () => {
  await withDir(async (dir) => {
    const identity = loadOrCreateInstanceIdentity(dir);
    assert.match(identity.publicKey, /^[A-Za-z0-9_-]{43}$/u);
    assert.match(identity.fingerprint, /^[A-Z2-7]{4}(-[A-Z2-7]{4}){3}$/u);
    assert.equal(identity.fingerprint, instanceFingerprint(Buffer.from(identity.publicKey, "base64url")));
  });
});

test("instance identity: signatures verify with node:crypto against the public key, and only for that message", async () => {
  await withDir(async (dir) => {
    const identity = loadOrCreateInstanceIdentity(dir);
    const message = instanceProofMessage("https://vault.example.com", "bm9uY2U");
    assert.equal(message, "dataconnect-instance-proof-v1\nhttps://vault.example.com\nbm9uY2U");
    const signature = Buffer.from(identity.sign(message), "base64url");
    const key = spkiFromRaw(Buffer.from(identity.publicKey, "base64url"));
    assert.equal(crypto.verify(null, Buffer.from(message), key, signature), true);
    for (const other of [
      instanceProofMessage("https://other.example.com", "bm9uY2U"),
      instanceProofMessage("https://vault.example.com", "bm9uY2V"),
    ]) {
      assert.equal(crypto.verify(null, Buffer.from(other), key, signature), false);
    }
  });
});

test("instance identity: an unparseable file is an error and is left untouched", async () => {
  await withDir(async (dir) => {
    const file = join(dir, INSTANCE_IDENTITY_FILE);
    await writeFile(file, "not json");
    assert.throws(() => loadOrCreateInstanceIdentity(dir), /refusing to replace/u);
    assert.equal(await readFile(file, "utf8"), "not json");
  });
});
