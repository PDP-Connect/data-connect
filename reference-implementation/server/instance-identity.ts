// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/**
 * The long-lived Ed25519 identity of this server instance. The DataConnect
 * desktop app pins the public half when it attaches, then asks the server to
 * sign a fresh nonce before it sends a stored session. The private key never
 * leaves this process and the file that holds it.
 */

export const INSTANCE_IDENTITY_FILE = "instance-identity.json";
export const INSTANCE_PROOF_DOMAIN = "dataconnect-instance-proof-v1";

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const FINGERPRINT_BYTES = 10;

export interface InstanceIdentity {
  /** 32 raw bytes, base64url, no padding. */
  readonly publicKey: string;
  /** `XXXX-XXXX-XXXX-XXXX`. */
  readonly fingerprint: string;
  /** Ed25519 signature of `message`, base64url. */
  readonly sign: (message: string) => string;
}

/** RFC 4648 base32 without padding. */
function base32(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
    value &= (1 << bits) - 1;
  }
  if (bits > 0) out += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

/** First 10 bytes of SHA-256 of the raw public key, base32, grouped by four. */
export function instanceFingerprint(rawPublicKey: Uint8Array): string {
  const digest = crypto.createHash("sha256").update(rawPublicKey).digest().subarray(0, FINGERPRINT_BYTES);
  return base32(digest).match(/.{4}/gu)?.join("-") ?? "";
}

/** The exact bytes the server signs: domain, origin and the nonce as sent. */
export function instanceProofMessage(origin: string, nonce: string): string {
  return `${INSTANCE_PROOF_DOMAIN}\n${origin}\n${nonce}`;
}

function rawPublicKeyOf(publicKey: crypto.KeyObject): Buffer {
  const x = publicKey.export({ format: "jwk" }).x;
  if (typeof x !== "string") throw new Error("instance identity: public key has no raw form");
  return Buffer.from(x, "base64url");
}

function fromPrivateKey(privateKey: crypto.KeyObject): InstanceIdentity {
  const raw = rawPublicKeyOf(crypto.createPublicKey(privateKey));
  return {
    publicKey: raw.toString("base64url"),
    fingerprint: instanceFingerprint(raw),
    sign: (message) => crypto.sign(null, Buffer.from(message, "utf8"), privateKey).toString("base64url"),
  };
}

function parseIdentityFile(text: string): crypto.KeyObject | null {
  try {
    const parsed = JSON.parse(text) as { private_key?: unknown };
    if (typeof parsed.private_key !== "string") return null;
    const key = crypto.createPrivateKey({
      key: Buffer.from(parsed.private_key, "base64url"),
      format: "der",
      type: "pkcs8",
    });
    return key.asymmetricKeyType === "ed25519" ? key : null;
  } catch {
    return null;
  }
}

function readExisting(file: string): crypto.KeyObject | null {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  const key = parseIdentityFile(text);
  if (!key) {
    throw new Error(`instance identity file ${file} exists but cannot be parsed; refusing to replace it`);
  }
  return key;
}

/**
 * Loads the identity from `<dataDir>/instance-identity.json`, creating it on
 * first use. A file that exists but does not parse is an error: replacing it
 * would silently change the server's identity for every attached desktop.
 */
export function loadOrCreateInstanceIdentity(dataDir: string): InstanceIdentity {
  const file = path.join(dataDir, INSTANCE_IDENTITY_FILE);
  const existing = readExisting(file);
  if (existing) return fromPrivateKey(existing);

  fs.mkdirSync(dataDir, { recursive: true });
  const { privateKey } = crypto.generateKeyPairSync("ed25519");
  const body = JSON.stringify({
    version: 1,
    created_at: new Date().toISOString(),
    private_key: privateKey.export({ format: "der", type: "pkcs8" }).toString("base64url"),
  });
  const temp = `${file}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`;
  fs.writeFileSync(temp, `${body}\n`, { mode: 0o600, flag: "wx" });
  try {
    // link() fails with EEXIST instead of replacing, so a concurrent first start cannot overwrite.
    fs.linkSync(temp, file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const winner = readExisting(file);
    if (winner) return fromPrivateKey(winner);
    throw error;
  } finally {
    fs.rmSync(temp, { force: true });
  }
  return fromPrivateKey(privateKey);
}

/** Lazy holder: nothing touches the disk until a pairing route needs the identity. */
export function createInstanceIdentityProvider(dataDir: string): () => InstanceIdentity {
  let cached: InstanceIdentity | null = null;
  return () => {
    cached ??= loadOrCreateInstanceIdentity(dataDir);
    return cached;
  };
}
