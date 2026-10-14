// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
export const STATE_DIR = process.env.VACUNA_STATE_DIR || join(HERE, "..", ".state");
export const AS_URL = process.env.VACUNA_AS_URL || "http://127.0.0.1:7662";
export const RS_URL = process.env.VACUNA_RS_URL || "http://127.0.0.1:7663";
export const DATABASE_URL = process.env.VACUNA_DATABASE_URL || "postgres://pdpp:pdpp@localhost:55432/pdpp";
export const OWNER_SUBJECT_ID = "owner_local";

/** Every Nth grant is revoked through the real revoke API (denied traffic). */
export const REVOKE_MODULUS = 100;
export const REVOKE_REMAINDER = 50;

export function isRevokedIndex(index: number): boolean {
  return index % REVOKE_MODULUS === REVOKE_REMAINDER;
}

function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

/**
 * Bulk-inserted grants use tokens derived from the child index so the load
 * generator can rebuild them without a 980k-line token file. Same 64-hex
 * shape as tokens the AS mints. Test database only.
 */
export function derivedToken(index: number): string {
  return sha256Hex(`vacuna-baseline-token:${index}`);
}

export function derivedGrantId(index: number): string {
  return `grt_${sha256Hex(`vacuna-baseline-grant:${index}`).slice(0, 16)}`;
}

export interface SeedState {
  clientId?: string;
  grantCount?: number;
  ownerToken?: string;
  realGrantCount?: number;
  recordCount?: number;
  revokedCount?: number;
  timings?: Record<string, { count: number; perSecond: number; seconds: number }>;
}

export function statePath(name: string): string {
  mkdirSync(STATE_DIR, { recursive: true });
  return join(STATE_DIR, name);
}

export function readState(): SeedState {
  try {
    return JSON.parse(readFileSync(statePath("state.json"), "utf8")) as SeedState;
  } catch {
    return {};
  }
}

export function writeState(state: SeedState): void {
  writeFileSync(statePath("state.json"), `${JSON.stringify(state, null, 2)}\n`);
}

/** Tokens minted by the real consent flow, indexed by child index. */
export function readRealTokens(): Record<string, string> {
  try {
    return JSON.parse(readFileSync(statePath("real-tokens.json"), "utf8")) as Record<string, string>;
  } catch {
    return {};
  }
}

export function writeRealTokens(tokens: Record<string, string>): void {
  writeFileSync(statePath("real-tokens.json"), JSON.stringify(tokens));
}

export function tokenFor(index: number, realTokens: Record<string, string>): string {
  return realTokens[String(index)] ?? derivedToken(index);
}

export function argValue(name: string, fallback: string): string {
  const flag = `--${name}`;
  const i = process.argv.indexOf(flag);
  if (i >= 0 && process.argv[i + 1] !== undefined) {
    return process.argv[i + 1] as string;
  }
  const prefixed = process.argv.find((a) => a.startsWith(`${flag}=`));
  return prefixed ? prefixed.slice(flag.length + 1) : fallback;
}

export function argInt(name: string, fallback: number): number {
  return Number.parseInt(argValue(name, String(fallback)), 10);
}

/** Run `worker` over [from, to] with at most `concurrency` in flight. */
export async function runPool(
  from: number,
  to: number,
  concurrency: number,
  worker: (index: number) => Promise<void>
): Promise<void> {
  let next = from;
  const lanes = Array.from({ length: concurrency }, async () => {
    while (next <= to) {
      const index = next;
      next += 1;
      await worker(index);
    }
  });
  await Promise.all(lanes);
}
