/**
 * DPoP proof checking (RFC 9449) for the lease endpoint, on node:crypto.
 * Supports EdDSA (Ed25519) and ES256 proof keys.
 *
 * PROTOTYPE: experimental AI Training Profile work, off by default.
 */

import type { KeyObject } from "node:crypto";
import {
  createHash,
  createPublicKey,
  type JsonWebKeyInput,
  verify,
} from "node:crypto";
import { decodeCompactJws, signCompactJws } from "./jws.ts";

export const DPOP_MAX_AGE_S = 300;

export type DpopCheck =
  | { ok: true; jkt: string; jti: string; iat: number }
  | { ok: false; reason: string };

function b64url(buf: Buffer): string {
  return buf.toString("base64url");
}

/** RFC 7638 thumbprint for OKP and EC public keys. */
export function thumbprint(jwk: Record<string, unknown>): string | null {
  let canonical: string;
  if (
    jwk.kty === "OKP" &&
    typeof jwk.crv === "string" &&
    typeof jwk.x === "string"
  ) {
    canonical = JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x });
  } else if (
    jwk.kty === "EC" &&
    typeof jwk.crv === "string" &&
    typeof jwk.x === "string" &&
    typeof jwk.y === "string"
  ) {
    canonical = JSON.stringify({
      crv: jwk.crv,
      kty: jwk.kty,
      x: jwk.x,
      y: jwk.y,
    });
  } else {
    return null;
  }
  return b64url(createHash("sha256").update(canonical).digest());
}

function normalizeHtu(url: string): string | null {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}${u.pathname}`;
  } catch {
    return null;
  }
}

export function checkDpopProof(input: {
  proof: unknown;
  method: string;
  url: string;
  nowS: number;
  /** When set, the proof MUST carry `ath`, the hash of this access token (RFC 9449 §4.2). */
  accessToken?: string;
}): DpopCheck {
  if (typeof input.proof !== "string") {
    return { ok: false, reason: "missing_proof" };
  }
  const d = decodeCompactJws(input.proof);
  if (!d) {
    return { ok: false, reason: "malformed" };
  }
  const { header, payload } = d;
  if (header.typ !== "dpop+jwt") {
    return { ok: false, reason: "wrong_typ" };
  }
  const jwk = header.jwk as Record<string, unknown> | undefined;
  if (!jwk || typeof jwk !== "object" || "d" in jwk) {
    return { ok: false, reason: "bad_jwk" };
  }
  const jkt = thumbprint(jwk);
  if (!jkt) {
    return { ok: false, reason: "bad_jwk" };
  }
  let ok = false;
  try {
    const key = createPublicKey({ key: jwk, format: "jwk" } as JsonWebKeyInput);
    const data = Buffer.from(d.signingInput);
    if (header.alg === "EdDSA" && jwk.kty === "OKP") {
      ok = verify(null, data, key, d.signature);
    } else if (
      header.alg === "ES256" &&
      jwk.kty === "EC" &&
      jwk.crv === "P-256"
    ) {
      ok = verify(
        "sha256",
        data,
        { key, dsaEncoding: "ieee-p1363" },
        d.signature,
      );
    }
  } catch {
    ok = false;
  }
  if (!ok) {
    return { ok: false, reason: "bad_signature" };
  }
  if (typeof payload.jti !== "string" || payload.jti.length < 8) {
    return { ok: false, reason: "bad_jti" };
  }
  if (payload.htm !== input.method) {
    return { ok: false, reason: "wrong_htm" };
  }
  if (
    typeof payload.htu !== "string" ||
    normalizeHtu(payload.htu) !== normalizeHtu(input.url)
  ) {
    return { ok: false, reason: "wrong_htu" };
  }
  if (
    typeof payload.iat !== "number" ||
    Math.abs(payload.iat - input.nowS) > DPOP_MAX_AGE_S
  ) {
    return { ok: false, reason: "stale_iat" };
  }
  if (
    input.accessToken !== undefined &&
    payload.ath !== b64url(createHash("sha256").update(input.accessToken).digest())
  ) {
    return { ok: false, reason: "wrong_ath" };
  }
  return { ok: true, jkt, jti: payload.jti, iat: payload.iat };
}

/** Client helper: build an EdDSA DPoP proof. */
export function makeDpopProof(input: {
  privateKey: KeyObject;
  publicJwk: Record<string, unknown>;
  method: string;
  url: string;
  jti: string;
  iatS: number;
  /** Access token to bind with `ath`. */
  accessToken?: string;
}): string {
  // signCompactJws always sets alg EdDSA.
  return signCompactJws(
    { typ: "dpop+jwt", jwk: input.publicJwk },
    {
      jti: input.jti,
      htm: input.method,
      htu: input.url,
      iat: input.iatS,
      ...(input.accessToken === undefined
        ? {}
        : { ath: b64url(createHash("sha256").update(input.accessToken).digest()) }),
    },
    input.privateKey,
  );
}
