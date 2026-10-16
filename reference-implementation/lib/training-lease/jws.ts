/**
 * Minimal compact JWS (RFC 7515) with EdDSA/Ed25519 (RFC 8037), on node:crypto
 * only. Shared by the AS lease signer, the DPoP proof checker, and the worker
 * validator in the AI-training lease prototype. No JOSE dependency.
 *
 * PROTOTYPE: experimental AI Training Profile work, not a Core surface.
 */
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign as edSign,
  verify as edVerify,
  generateKeyPairSync,
  type KeyObject,
} from "node:crypto";

export interface OkpPublicJwk {
  kty: "OKP";
  crv: "Ed25519";
  x: string;
  kid?: string;
  use?: string;
  alg?: string;
}

export interface Ed25519KeyPair {
  kid: string;
  privateKey: KeyObject;
  publicJwk: OkpPublicJwk;
}

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

export function generateEd25519KeyPair(kid?: string): Ed25519KeyPair {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const jwk = publicKey.export({ format: "jwk" }) as { x: string };
  const publicJwk: OkpPublicJwk = { kty: "OKP", crv: "Ed25519", x: jwk.x };
  return {
    kid: kid ?? jwkThumbprint(publicJwk),
    privateKey,
    publicJwk,
  };
}

/** Serialize a private key for storage (PKCS#8 PEM). */
export function exportPrivateKeyPem(key: KeyObject): string {
  return key.export({ format: "pem", type: "pkcs8" }).toString();
}

export function importPrivateKeyPem(pem: string): KeyObject {
  return createPrivateKey(pem);
}

/** RFC 7638 thumbprint of an OKP key. */
export function jwkThumbprint(jwk: OkpPublicJwk): string {
  const canonical = JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x });
  return b64url(createHash("sha256").update(canonical).digest());
}

export function signCompactJws(
  header: Record<string, unknown>,
  payload: Record<string, unknown>,
  privateKey: KeyObject,
): string {
  const h = b64url(JSON.stringify({ ...header, alg: "EdDSA" }));
  const p = b64url(JSON.stringify(payload));
  const sig = edSign(null, Buffer.from(`${h}.${p}`), privateKey);
  return `${h}.${p}.${b64url(sig)}`;
}

export interface DecodedJws {
  header: Record<string, unknown>;
  payload: Record<string, unknown>;
  signingInput: string;
  signature: Buffer;
}

export function decodeCompactJws(token: string): DecodedJws | null {
  if (typeof token !== "string") {
    return null;
  }
  const parts = token.split(".");
  if (parts.length !== 3) {
    return null;
  }
  const [h, p, s] = parts as [string, string, string];
  try {
    const header = JSON.parse(Buffer.from(h, "base64url").toString("utf8"));
    const payload = JSON.parse(Buffer.from(p, "base64url").toString("utf8"));
    if (
      !header ||
      typeof header !== "object" ||
      !payload ||
      typeof payload !== "object"
    ) {
      return null;
    }
    return {
      header,
      payload,
      signingInput: `${h}.${p}`,
      signature: Buffer.from(s, "base64url"),
    };
  } catch {
    return null;
  }
}

export function publicKeyFromJwk(jwk: OkpPublicJwk): KeyObject {
  return createPublicKey({
    key: { kty: "OKP", crv: "Ed25519", x: jwk.x },
    format: "jwk",
  });
}

export function verifyDecodedJws(
  decoded: DecodedJws,
  jwk: OkpPublicJwk,
): boolean {
  if (decoded.header.alg !== "EdDSA") {
    return false;
  }
  if (jwk.kty !== "OKP" || jwk.crv !== "Ed25519") {
    return false;
  }
  try {
    return edVerify(
      null,
      Buffer.from(decoded.signingInput),
      publicKeyFromJwk(jwk),
      decoded.signature,
    );
  } catch {
    return false;
  }
}
