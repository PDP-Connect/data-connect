// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Local state of the Moksha run: one JSON file, rewritten atomically after
// every change (write to a temp file, rename). Holds ids, addresses, tx
// hashes and payment outcomes; never key material.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type PaymentStatus = "prepared" | "accepted" | "rejected" | "capped" | "settled";

export interface ChildState {
  childId: string;
  dataPointId: string | null;
  dataVersion: string | null;
  /** grantId from POST /v1/grants (content-addressed by the gateway with the permissions contract's separator). */
  grantId: string | null;
  /** Read whose payment carries this grant's registration fee (opType grant). */
  grantPaymentReadId: string | null;
  grantPaid: boolean;
  grantVersion: string | null;
  ownerAddress: string;
  registeredAt: string | null;
  serverAddress: string;
  serverId: string | null;
  /** Last GET /v1/grants view: chain status and tx of the grant registration. */
  grantChain: { paymentStatus: string; settleTxHash: string | null; status: string } | null;
}

export interface PaymentState {
  acceptedAt: string | null;
  amountWei: string;
  childId: string;
  explorerUrl: string | null;
  nonce: string;
  opId: string;
  opType: "data_access" | "grant";
  preparedAt: string;
  readId: string;
  response: unknown;
  settleBlock: string | null;
  settledAt: string | null;
  settleTxHash: string | null;
  status: PaymentStatus;
}

export interface DepositState {
  account: string;
  amountWei: string;
  chainNonce: string;
  createdAt: string;
  gatewayStatus: string | null;
  submittedToGateway: boolean;
  txHash: string;
}

export interface MokshaStateData {
  builder: { address: string; builderId: string | null; registeredAt: string | null } | null;
  children: Record<string, ChildState>;
  deposits: DepositState[];
  lastNonce: string;
  payments: Record<string, PaymentState>;
  poll: {
    balance: unknown;
    fromBlock: string | null;
    lastPolledAt: string | null;
    /** First block the in-server watcher scanned (settlement-watch.ts). */
    startBlock?: string | null;
    unmatchedSettlements: { opKind: number; ref: string; txHash: string }[];
  };
  version: 1;
}

function empty(): MokshaStateData {
  return {
    builder: null,
    children: {},
    deposits: [],
    lastNonce: "0",
    payments: {},
    poll: { balance: null, fromBlock: null, lastPolledAt: null, unmatchedSettlements: [] },
    version: 1,
  };
}

export class MokshaState {
  readonly path: string;
  data: MokshaStateData;
  private readonly now: () => Date;

  constructor(dir: string, opts: { now?: () => Date } = {}) {
    mkdirSync(dir, { mode: 0o700, recursive: true });
    this.path = join(dir, "moksha-state.json");
    this.now = opts.now ?? (() => new Date());
    try {
      this.data = { ...empty(), ...(JSON.parse(readFileSync(this.path, "utf8")) as MokshaStateData) };
    } catch {
      this.data = empty();
    }
  }

  nowIso(): string {
    return this.now().toISOString();
  }

  save(): void {
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(this.data, null, 2)}\n`, { mode: 0o600 });
    renameSync(tmp, this.path);
  }

  /**
   * Payment nonces only need to be unique per payer (data-gateway
   * payments_payer_nonce_kind_unique). Seeding from the wall clock keeps a
   * wiped state dir from replaying a nonce the gateway already holds.
   */
  nextNonce(): bigint {
    const floor = BigInt(this.now().getTime()) * 1000n;
    const last = BigInt(this.data.lastNonce);
    const next = last >= floor ? last + 1n : floor;
    this.data.lastNonce = next.toString();
    this.save();
    return next;
  }

  paidReadCount(): number {
    return Object.values(this.data.payments).filter((p) => p.status !== "capped").length;
  }

  /** Rows for a dashboard: one per payment, newest first. */
  dashboardRows(): PaymentState[] {
    return Object.values(this.data.payments).sort((a, b) => b.preparedAt.localeCompare(a.preparedAt));
  }
}
