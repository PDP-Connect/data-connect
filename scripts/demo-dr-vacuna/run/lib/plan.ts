// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Pilot volumes (PRD) scaled by one factor, plus the run's paths and the
// server environment (every pilot flag on).

import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const RUN_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
export const DEMO_DIR = join(RUN_DIR, "..");

/** PRD figures at scale 1. */
export const PILOT = {
  badTokenReads: 40_000,
  children: 980_200,
  consentRefusals: 60_000,
  outOfGrantFieldReads: 100_000,
  readsAfterRevocation: 200_000,
  suspendedRefusals: 10_000,
  weeks: 4,
} as const;

export interface Plan {
  badTokenReads: number;
  children: number;
  consentRefusals: number;
  /** Reads the reminder service is expected to be paid for: one per child per week. */
  expectedPaidReads: number;
  outOfGrantFieldReads: number;
  readsAfterRevocation: number;
  /** Every `revokeEvery`-th child (offset revokeOffset) is revoked after week 4. */
  revokeEvery: number;
  revokeOffset: number;
  revokedChildren: number;
  scale: number;
  seed: number;
  suspendedRefusals: number;
  /** PRD total: paid reads + denied requests (RS denials + consent refusals). */
  totalRequests: number;
  weeks: number;
}

export function buildPlan(scale: number, seed: number, revokeEvery = 50): Plan {
  if (!(scale > 0 && scale <= 1)) {
    throw new Error(`--scale must be in (0, 1], got ${scale}`);
  }
  const r = (n: number) => Math.max(1, Math.round(n * scale));
  const children = r(PILOT.children);
  const revokeOffset = Math.floor(revokeEvery / 2);
  const revokedChildren = Math.floor((children - revokeOffset) / revokeEvery) + (children >= revokeOffset ? 1 : 0);
  const plan = {
    badTokenReads: Math.max(2, r(PILOT.badTokenReads)), // at least one expired and one malformed
    children,
    consentRefusals: r(PILOT.consentRefusals),
    expectedPaidReads: children * PILOT.weeks,
    outOfGrantFieldReads: r(PILOT.outOfGrantFieldReads),
    readsAfterRevocation: r(PILOT.readsAfterRevocation),
    revokeEvery,
    revokeOffset,
    revokedChildren,
    scale,
    seed,
    suspendedRefusals: r(PILOT.suspendedRefusals),
    totalRequests: 0,
    weeks: PILOT.weeks,
  };
  plan.totalRequests =
    plan.expectedPaidReads +
    plan.readsAfterRevocation +
    plan.outOfGrantFieldReads +
    plan.badTokenReads +
    plan.consentRefusals;
  return plan;
}

export function isRevokedChild(plan: Pick<Plan, "revokeEvery" | "revokeOffset">, index: number): boolean {
  return index % plan.revokeEvery === plan.revokeOffset;
}

/** Deterministic PRNG for sampling and request order (mulberry32). */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d_2b_79_f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

export interface RunPaths {
  baselineState: string;
  ledger: string;
  receiptsKey: string;
  receiptsLog: string;
  reminderState: string;
  root: string;
  runJson: string;
  serverLog: string;
}

export function runPaths(label: string, base = join(RUN_DIR, ".state")): RunPaths {
  const root = join(base, label);
  const paths = {
    baselineState: join(root, "baseline"),
    ledger: join(root, "payer-ledger.jsonl"),
    receiptsKey: join(root, "receipts-key.pem"),
    receiptsLog: join(root, "receipts.jsonl"),
    reminderState: join(root, "reminder"),
    root,
    runJson: join(root, "run.json"),
    serverLog: join(root, "server.log"),
  };
  mkdirSync(paths.baselineState, { recursive: true });
  mkdirSync(paths.reminderState, { recursive: true });
  return paths;
}

export const AS_PORT = Number(process.env.VACUNA_RUN_AS_PORT || 7762);
export const RS_PORT = Number(process.env.VACUNA_RUN_RS_PORT || 7763);
export const AS_URL = `http://127.0.0.1:${AS_PORT}`;
export const RS_URL = `http://127.0.0.1:${RS_PORT}`;
export const DATABASE_URL = process.env.VACUNA_DATABASE_URL || "postgres://pdpp:pdpp@localhost:55432/pdpp";
/** Demo-only RS introspection credentials (also used by the reminder service's status checks). */
export const INTROSPECTION_ID = "vacuna-rs";
export const INTROSPECTION_SECRET = "vacuna-run-rs-introspection-secret";

/** Environment shared by the server and every harness process of one run. */
export function runEnv(paths: RunPaths, poolMax: number): NodeJS.ProcessEnv {
  return {
    ...process.env,
    AS_PORT: String(AS_PORT),
    PDPP_AUDIT_COALESCE_READ_EVENTS: "1",
    PDPP_AUDIT_TOKEN_HMAC_KEY: "vacuna-integration-run-audit-token-hmac-key",
    PDPP_CONFIDENTIAL_CLIENTS: "1",
    PDPP_HTTP_KEEP_ALIVE: "1",
    PDPP_PG_INTERACTIVE_POOL_MAX: String(poolMax),
    PDPP_PILOT_DR_VACUNA: "1",
    PDPP_READ_RECEIPTS: "1",
    PDPP_READ_RECEIPTS_KEY_FILE: paths.receiptsKey,
    PDPP_READ_RECEIPTS_LOG: paths.receiptsLog,
    PDPP_RS_INPROCESS_INTROSPECTION: "1",
    PDPP_RS_INTROSPECTION_CLIENT_ID: INTROSPECTION_ID,
    PDPP_RS_INTROSPECTION_CLIENT_SECRET: INTROSPECTION_SECRET,
    RS_PORT: String(RS_PORT),
    VACUNA_AS_URL: AS_URL,
    VACUNA_DATABASE_URL: DATABASE_URL,
    VACUNA_INTROSPECTION_CLIENT_ID: INTROSPECTION_ID,
    VACUNA_INTROSPECTION_CLIENT_SECRET: INTROSPECTION_SECRET,
    VACUNA_REMINDER_STATE_DIR: paths.reminderState,
    VACUNA_RS_URL: RS_URL,
    VACUNA_STATE_DIR: paths.baselineState,
  };
}
