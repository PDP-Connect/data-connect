// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { createECDH } from "node:crypto";

import { exec, getOne, referenceQueries } from "../lib/db.ts";
import { isPostgresStorageBackend, postgresQuery } from "./postgres-storage.ts";
import { type CredentialCipher, createCredentialCipherFromEnv } from "./stores/credential-encryption.ts";

/**
 * The instance's Web Push (VAPID, RFC 8292) signing key pair.
 *
 * The server owns this pair: it is generated the first time it is needed and
 * kept in the database, so no operator ever creates or configures one. The
 * private key is sealed with the credential encryption key and never stored in
 * plaintext; the public key is stored plain because browsers subscribe against
 * it.
 */
export interface WebPushVapidKeys {
  privateKey: string;
  publicKey: string;
}

interface VapidKeyRow {
  public_key: string;
  sealed_private_key: string;
}

/** Same curve and encoding as `web-push`'s `generateVAPIDKeys()`: P-256, base64url, uncompressed public point. */
function generateVapidKeys(): WebPushVapidKeys {
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  return {
    privateKey: ecdh.getPrivateKey().toString("base64url"),
    publicKey: ecdh.getPublicKey().toString("base64url"),
  };
}

async function readRow(): Promise<VapidKeyRow | null> {
  if (isPostgresStorageBackend()) {
    const result = await postgresQuery<VapidKeyRow>(
      "SELECT public_key, sealed_private_key FROM web_push_vapid_keys WHERE singleton = 1"
    );
    return result.rows[0] ?? null;
  }
  return getOne<VapidKeyRow>(referenceQueries.webPushVapidKeyGet, []);
}

async function insertIfAbsent(row: VapidKeyRow): Promise<void> {
  const createdAt = new Date().toISOString();
  if (isPostgresStorageBackend()) {
    await postgresQuery(
      `INSERT INTO web_push_vapid_keys(singleton, public_key, sealed_private_key, created_at)
       VALUES(1, $1, $2, $3)
       ON CONFLICT(singleton) DO NOTHING`,
      [row.public_key, row.sealed_private_key, createdAt]
    );
    return;
  }
  exec(referenceQueries.webPushVapidKeyInsertIfAbsent, [row.public_key, row.sealed_private_key, createdAt]);
}

/**
 * Return the instance's key pair, creating it on first use. Concurrent first
 * uses (two processes, or two requests) converge on one stored pair: every
 * caller inserts only if absent and then reads back whatever won.
 *
 * Throws `CredentialEncryptionError` when no credential encryption key is
 * configured or the stored private key cannot be opened with it. It never
 * replaces a stored pair it cannot read, because every existing subscription
 * is bound to that pair.
 */
export async function loadOrCreateWebPushVapidKeys(
  cipher: CredentialCipher = createCredentialCipherFromEnv()
): Promise<WebPushVapidKeys> {
  let row = await readRow();
  if (!row) {
    const generated = generateVapidKeys();
    await insertIfAbsent({ public_key: generated.publicKey, sealed_private_key: cipher.seal(generated.privateKey) });
    row = await readRow();
  }
  if (!row) {
    throw new Error("Web Push signing key was not stored");
  }
  return { privateKey: cipher.open(row.sealed_private_key), publicKey: row.public_key };
}
