// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import crypto from "node:crypto";

export const OWNER_PASSWORD_MIN_LENGTH = 15;

const SCRYPT_KEY_LENGTH = 32;
const SCRYPT_OPTIONS = { maxmem: 64 * 1024 * 1024, N: 16_384, p: 1, r: 8 } as const;

export interface OwnerPasswordVerifier {
  readonly algorithm: "scrypt";
  readonly hash: string;
  readonly salt: string;
  readonly version: 1;
}

function scrypt(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, SCRYPT_KEY_LENGTH, SCRYPT_OPTIONS, (error, derivedKey) => {
      if (error) {
        reject(error);
      } else {
        resolve(derivedKey as Buffer);
      }
    });
  });
}

export function ownerPasswordLength(password: string): number {
  return Array.from(password).length;
}

export function parseOwnerPasswordVerifier(value: unknown): OwnerPasswordVerifier {
  if (!value || typeof value !== "object") {
    throw new Error("Stored owner password verifier is malformed.");
  }
  const candidate = value as Record<string, unknown>;
  const salt = typeof candidate.salt === "string" ? Buffer.from(candidate.salt, "base64url") : Buffer.alloc(0);
  const hash = typeof candidate.hash === "string" ? Buffer.from(candidate.hash, "base64url") : Buffer.alloc(0);
  if (
    candidate.algorithm !== "scrypt" ||
    candidate.version !== 1 ||
    salt.length !== 16 ||
    hash.length !== SCRYPT_KEY_LENGTH ||
    salt.toString("base64url") !== candidate.salt ||
    hash.toString("base64url") !== candidate.hash
  ) {
    throw new Error("Stored owner password verifier is malformed.");
  }
  return { algorithm: "scrypt", hash: candidate.hash as string, salt: candidate.salt as string, version: 1 };
}

export async function createOwnerPasswordVerifier(password: string): Promise<OwnerPasswordVerifier> {
  if (typeof password !== "string" || ownerPasswordLength(password) < OWNER_PASSWORD_MIN_LENGTH) {
    throw new Error(`Owner passwords must be at least ${OWNER_PASSWORD_MIN_LENGTH} characters long.`);
  }
  const salt = crypto.randomBytes(16);
  const hash = await scrypt(password, salt);
  return { algorithm: "scrypt", hash: hash.toString("base64url"), salt: salt.toString("base64url"), version: 1 };
}

export async function verifyOwnerPassword(password: string, verifierValue: OwnerPasswordVerifier): Promise<boolean> {
  if (typeof password !== "string") {
    return false;
  }
  const verifier = parseOwnerPasswordVerifier(verifierValue);
  const expected = Buffer.from(verifier.hash, "base64url");
  const actual = await scrypt(password, Buffer.from(verifier.salt, "base64url"));
  return crypto.timingSafeEqual(actual, expected);
}
