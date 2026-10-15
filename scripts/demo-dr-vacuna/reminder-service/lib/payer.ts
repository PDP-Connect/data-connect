// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Per-read payment through Vana's data-gateway.
//
// The service calls `prepare` once per served read (the signed body is then
// persisted with the read) and `send` to deliver it. A pending body is resent
// unchanged after a crash or a transport failure; the gateway treats an
// identical data_access payment as idempotent (200), so a read is paid once.
//
// HttpGatewayPayer implements data-gateway `POST /v1/escrow/pay` as read from
// the sibling repo (api/v1/escrow/pay.ts, lib/eip712.ts, lib/auth.ts,
// lib/data-points.ts):
//
//   Authorization: Web3Signed <0x 65-byte EIP-712 signature>
//   { payerAddress, opType: "data_access", opId, asset, amount, paymentNonce,
//     accessRecord: { dataPointId, version, accessor, recordId, signature } }
//
//   GenericPayment(address payerAddress, string opType, bytes32 opId,
//     address asset, uint256 amount, uint256 paymentNonce)
//   domain { name: "Vana Data Portability", version: "1", chainId,
//     verifyingContract: DataPortabilityEscrow }
//
//   accessRecord.signature: RecordDataAccess(address ownerAddress,
//     string scope, uint256 version, address accessor, bytes32 recordId)
//     signed by a trusted server of ownerAddress, domain verifyingContract =
//     DataRegistry; dataPointId = keccak256(abi.encode(ownerAddress, scope)).
//
// For data_access the gateway requires opId == accessRecord.recordId and
// accessor == payerAddress. Here recordId is the register's read id (the
// 32-byte `read_id` in its read receipt), so one payment maps to one served
// read. Amounts are decimal wei strings; 0.01 VANA = 10^16.

import { encodeAbiParameters, getAddress, type Hex, keccak256 } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { FetchLike } from "./oauth.ts";

export const ONE_HUNDREDTH_VANA_WEI = "10000000000000000";
export const NATIVE_ASSET = "0x0000000000000000000000000000000000000000";

export interface PaidRead {
  childId: string;
  childIndex: number;
  grantId: string;
  /** 0x-prefixed 32-byte hex: the register's read id. */
  readId: string;
  recordSha256: string;
  servedAt: string | null;
}

export interface SendResult {
  accepted: boolean;
  response: unknown;
  /** True when the outcome is unknown or transient and the same body may be resent. */
  retryable: boolean;
}

export interface GatewayPayer {
  readonly name: string;
  prepare: (read: PaidRead) => Promise<{ amount: string; bodyJson: string }>;
  send: (bodyJson: string) => Promise<SendResult>;
}

/** Records payments in memory (and the caller's store); used for tests and settlement-off runs. */
export class MockPayer implements GatewayPayer {
  readonly name = "mock";
  readonly ledger: { amount: string; grantId: string; readId: string }[] = [];
  sendCalls = 0;
  private readonly seen = new Set<string>();
  private readonly amount: string;
  constructor(opts: { amountWei?: string } = {}) {
    this.amount = opts.amountWei ?? ONE_HUNDREDTH_VANA_WEI;
  }
  prepare(read: PaidRead) {
    return Promise.resolve({
      amount: this.amount,
      bodyJson: JSON.stringify({ amount: this.amount, grantId: read.grantId, readId: read.readId }),
    });
  }
  send(bodyJson: string): Promise<SendResult> {
    this.sendCalls += 1;
    const body = JSON.parse(bodyJson) as { amount: string; grantId: string; readId: string };
    if (!this.seen.has(body.readId)) {
      this.seen.add(body.readId);
      this.ledger.push(body);
    }
    return Promise.resolve({ accepted: true, response: { success: true }, retryable: false });
  }
}

export interface GatewayConfig {
  /** Native VANA is the zero address. */
  asset: string;
  amountWei: string;
  /** Builder (payer) private key, 0x hex. Read from env; throwaway keys only in this demo. */
  builderPrivateKey: Hex;
  chainId: bigint;
  dataOwnerAddress: string;
  dataPointScope: string;
  dataPointVersion: bigint;
  dataRegistryContract: string;
  escrowContract: string;
  gatewayUrl: string;
  /**
   * Key of the trusted server that signs RecordDataAccess. In the pilot this
   * is the register (the data's trusted server), not the reminder service;
   * the demo holds a throwaway key so the request is complete.
   */
  registerServerPrivateKey: Hex;
}

export function computeDataPointId(ownerAddress: string, scope: string): Hex {
  return keccak256(
    encodeAbiParameters(
      [
        { name: "ownerAddress", type: "address" },
        { name: "scope", type: "string" },
      ],
      [getAddress(ownerAddress), scope]
    )
  );
}

export const GENERIC_PAYMENT_TYPES = {
  GenericPayment: [
    { name: "payerAddress", type: "address" },
    { name: "opType", type: "string" },
    { name: "opId", type: "bytes32" },
    { name: "asset", type: "address" },
    { name: "amount", type: "uint256" },
    { name: "paymentNonce", type: "uint256" },
  ],
} as const;

export const RECORD_DATA_ACCESS_TYPES = {
  RecordDataAccess: [
    { name: "ownerAddress", type: "address" },
    { name: "scope", type: "string" },
    { name: "version", type: "uint256" },
    { name: "accessor", type: "address" },
    { name: "recordId", type: "bytes32" },
  ],
} as const;

export function vanaDomain(chainId: bigint, verifyingContract: string) {
  return { chainId, name: "Vana Data Portability", verifyingContract: getAddress(verifyingContract), version: "1" } as const;
}

const BYTES32_RE = /^0x[0-9a-fA-F]{64}$/;

export class HttpGatewayPayer implements GatewayPayer {
  readonly name = "data-gateway";
  sendCalls = 0;
  private readonly builder: ReturnType<typeof privateKeyToAccount>;
  private readonly config: GatewayConfig;
  private readonly fetchImpl: FetchLike;
  private readonly nextNonce: () => bigint;
  private readonly server: ReturnType<typeof privateKeyToAccount>;

  constructor(opts: { config: GatewayConfig; fetchImpl?: FetchLike; nextNonce: () => bigint }) {
    this.config = opts.config;
    this.builder = privateKeyToAccount(opts.config.builderPrivateKey);
    this.server = privateKeyToAccount(opts.config.registerServerPrivateKey);
    this.fetchImpl = opts.fetchImpl ?? ((url, init) => fetch(url, init));
    this.nextNonce = opts.nextNonce;
  }

  get payerAddress(): string {
    return this.builder.address;
  }

  async prepare(read: PaidRead) {
    if (!BYTES32_RE.test(read.readId)) {
      throw new Error(`readId must be bytes32 hex: ${read.readId}`);
    }
    const c = this.config;
    const recordId = read.readId.toLowerCase() as Hex;
    const accessor = this.builder.address;
    const accessSignature = await this.server.signTypedData({
      domain: vanaDomain(c.chainId, c.dataRegistryContract),
      message: {
        accessor,
        ownerAddress: getAddress(c.dataOwnerAddress),
        recordId,
        scope: c.dataPointScope,
        version: c.dataPointVersion,
      },
      primaryType: "RecordDataAccess",
      types: RECORD_DATA_ACCESS_TYPES,
    });
    const paymentNonce = this.nextNonce();
    const asset = getAddress(c.asset);
    const signature = await this.builder.signTypedData({
      domain: vanaDomain(c.chainId, c.escrowContract),
      message: {
        amount: BigInt(c.amountWei),
        asset,
        opId: recordId,
        opType: "data_access",
        payerAddress: accessor,
        paymentNonce,
      },
      primaryType: "GenericPayment",
      types: GENERIC_PAYMENT_TYPES,
    });
    const body = {
      accessRecord: {
        accessor,
        dataPointId: computeDataPointId(c.dataOwnerAddress, c.dataPointScope),
        recordId,
        signature: accessSignature,
        version: c.dataPointVersion.toString(),
      },
      amount: c.amountWei,
      asset,
      opId: recordId,
      opType: "data_access",
      payerAddress: accessor,
      paymentNonce: paymentNonce.toString(),
    };
    return { amount: c.amountWei, bodyJson: JSON.stringify({ authorization: `Web3Signed ${signature}`, body }) };
  }

  async send(bodyJson: string): Promise<SendResult> {
    this.sendCalls += 1;
    const { authorization, body } = JSON.parse(bodyJson) as { authorization: string; body: unknown };
    let resp: Response;
    try {
      resp = await this.fetchImpl(`${this.config.gatewayUrl.replace(/\/+$/, "")}/v1/escrow/pay`, {
        body: JSON.stringify(body),
        headers: { Authorization: authorization, "Content-Type": "application/json" },
        method: "POST",
        signal: AbortSignal.timeout(30_000),
      });
    } catch (err) {
      return { accepted: false, response: { error: String((err as Error).message ?? err) }, retryable: true };
    }
    const text = await resp.text();
    let parsed: unknown = text;
    try {
      parsed = JSON.parse(text);
    } catch {
      // keep raw text
    }
    if (resp.status === 200 && (parsed as { success?: boolean }).success === true) {
      return { accepted: true, response: parsed, retryable: false };
    }
    // 5xx / 502 (fee or chain lookup) are transient; 4xx are final for this body.
    return { accepted: false, response: { body: parsed, status: resp.status }, retryable: resp.status >= 500 };
  }
}
