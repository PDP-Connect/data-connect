// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Register read receipts (demo, off by default).
//
// With PDPP_READ_RECEIPTS=1 the RS signs one receipt per served single-record
// read and returns it in the `PDPP-Read-Receipt` response header as a compact
// JWS (RFC 7515). Payload:
//
//   { v: 1, record_sha256, grant_id, read_id, request_id, served_at }
//
// `record_sha256` is the hex SHA-256 of the exact response body bytes, so a
// client verifies by hashing what it received. `read_id` is a fresh 32-byte
// hex value (0x-prefixed) that can serve as a per-read payment/settlement id;
// `request_id` is the read's spine query id, linking the receipt to the
// `query.received` / `disclosure.served` audit rows.
//
// Keys: PDPP_READ_RECEIPTS_KEY_FILE names a PKCS#8 PEM private key (Ed25519
// -> alg EdDSA, secp256k1 -> alg ES256K). A missing file is generated (0600)
// with the SPKI public key next to it as `<file>.pub`. Without the variable
// an ephemeral Ed25519 key is used. PDPP_READ_RECEIPTS_LOG names a JSONL file
// that gets one `key` line at start and one `receipt` line per receipt.
//
// The hook serializes the body itself and the route sends that string, so
// the hashed bytes are the bytes on the wire.

import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  type KeyObject,
  randomBytes,
  sign as cryptoSign,
} from "node:crypto";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";

export const READ_RECEIPT_HEADER = "PDPP-Read-Receipt";
export const READ_RECEIPT_JWS_TYP = "pdpp-read-receipt+jws";

export interface ReadReceiptPayload {
  grant_id: string | null;
  read_id: string;
  record_sha256: string;
  request_id: string | null;
  served_at: string;
  v: 1;
}

export interface ReadReceiptStats {
  alg: string;
  kid: string;
  public_key_pem: string;
  receipts_signed: number;
}

export interface ReadReceiptHook {
  /** Serializes `body`, signs a receipt over it, sets the header, returns the serialized body to send. */
  sign: (
    res: { setHeader: (name: string, value: string) => unknown },
    input: { body: unknown; grantId: string | null | undefined; requestId: string | null | undefined }
  ) => string;
  stats: () => ReadReceiptStats;
}

function enabled(env: NodeJS.ProcessEnv): boolean {
  const raw = (env.PDPP_READ_RECEIPTS || "").trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes";
}

function loadOrCreateKey(keyFile: string | undefined): KeyObject {
  if (!keyFile) {
    return generateKeyPairSync("ed25519").privateKey;
  }
  if (existsSync(keyFile)) {
    return createPrivateKey(readFileSync(keyFile, "utf8"));
  }
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  writeFileSync(keyFile, privateKey.export({ format: "pem", type: "pkcs8" }), { mode: 0o600 });
  writeFileSync(`${keyFile}.pub`, publicKey.export({ format: "pem", type: "spki" }));
  return privateKey;
}

function algFor(key: KeyObject): "EdDSA" | "ES256K" {
  if (key.asymmetricKeyType === "ed25519") {
    return "EdDSA";
  }
  if (key.asymmetricKeyType === "ec" && key.asymmetricKeyDetails?.namedCurve === "secp256k1") {
    return "ES256K";
  }
  throw new Error("PDPP_READ_RECEIPTS_KEY_FILE must hold an Ed25519 or secp256k1 private key");
}

export function createReadReceiptHook(options: {
  key: KeyObject;
  logFile?: string | null;
  now?: () => Date;
}): ReadReceiptHook {
  const { key } = options;
  const alg = algFor(key);
  const publicKeyPem = createPublicKey(key).export({ format: "pem", type: "spki" }).toString();
  const spkiDer = createPublicKey(key).export({ format: "der", type: "spki" });
  const kid = createHash("sha256").update(spkiDer).digest("base64url").slice(0, 16);
  const logFile = options.logFile || null;
  const now = options.now ?? (() => new Date());
  const header = Buffer.from(JSON.stringify({ alg, kid, typ: READ_RECEIPT_JWS_TYP })).toString("base64url");
  let receiptsSigned = 0;
  if (logFile) {
    appendFileSync(logFile, `${JSON.stringify({ alg, kid, public_key_pem: publicKeyPem, type: "key" })}\n`);
  }
  return {
    sign(res, input) {
      const serialized = JSON.stringify(input.body);
      const payload: ReadReceiptPayload = {
        grant_id: input.grantId ?? null,
        read_id: `0x${randomBytes(32).toString("hex")}`,
        record_sha256: createHash("sha256").update(serialized, "utf8").digest("hex"),
        request_id: input.requestId ?? null,
        served_at: now().toISOString(),
        v: 1,
      };
      const encodedPayload = Buffer.from(JSON.stringify(payload)).toString("base64url");
      const signingInput = Buffer.from(`${header}.${encodedPayload}`, "ascii");
      const signature =
        alg === "EdDSA"
          ? cryptoSign(null, signingInput, key)
          : cryptoSign("sha256", signingInput, { dsaEncoding: "ieee-p1363", key });
      res.setHeader(READ_RECEIPT_HEADER, `${header}.${encodedPayload}.${signature.toString("base64url")}`);
      receiptsSigned += 1;
      if (logFile) {
        appendFileSync(logFile, `${JSON.stringify({ ...payload, type: "receipt" })}\n`);
      }
      return serialized;
    },
    stats: () => ({ alg, kid, public_key_pem: publicKeyPem, receipts_signed: receiptsSigned }),
  };
}

/** Returns null unless PDPP_READ_RECEIPTS is on. */
export function createReadReceiptHookFromEnv(env: NodeJS.ProcessEnv = process.env): ReadReceiptHook | null {
  if (!enabled(env)) {
    return null;
  }
  return createReadReceiptHook({
    key: loadOrCreateKey(env.PDPP_READ_RECEIPTS_KEY_FILE || undefined),
    logFile: env.PDPP_READ_RECEIPTS_LOG || null,
  });
}
