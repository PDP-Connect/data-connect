// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// GatewayPayer for the Moksha run (`node cli.ts week --payer moksha` in the
// reminder service). Per paid read it:
//
//   1. runs the registration hook (Registrar.ensureChild): the child's server,
//      data point and grant exist on the gateway before its first payment;
//   2. picks the payment form. A child's first payment is opType "grant"
//      (opId = grantId, amount = grant_registration + data_access fee): the
//      gateway flips a grant to paid only that way, and refuses data_access
//      against an unpaid grant (data-gateway api/v1/escrow/pay.ts). Later
//      reads are opType "data_access" (opId = the read id, 0.01 VANA);
//   3. signs with the per-child server key (RecordDataAccess) and the
//      builder key (GenericPayment), and records the outcome in state for
//      the settlement poller.
//
// A hard cap (VACUNA_MOKSHA_MAX_PAID_READS) stops signing new payments; a
// capped read is recorded and never sent.

import type { Hex } from "viem";
import type { FetchLike } from "../../reminder-service/lib/oauth.ts";
import {
  type GatewayPayer,
  type PaidRead,
  postEscrowPay,
  type SendResult,
  signGatewayPayment,
} from "../../reminder-service/lib/payer.ts";
import type { MokshaConfig } from "./config.ts";
import type { MokshaKeys } from "./keys.ts";
import type { Registrar } from "./register.ts";
import type { MokshaState } from "./state.ts";

const BYTES32_RE = /^0x[0-9a-fA-F]{64}$/;

interface MokshaBody {
  authorization?: string;
  body?: unknown;
  capped?: boolean;
  meta: { childId: string; opType: "data_access" | "grant"; readId: string };
}

export class MokshaPayer implements GatewayPayer {
  readonly name = "moksha";
  sendCalls = 0;
  private readonly config: MokshaConfig;
  private readonly fetchImpl: FetchLike;
  private readonly keys: MokshaKeys;
  private readonly registrar: Registrar;
  private readonly state: MokshaState;

  constructor(opts: { config: MokshaConfig; fetchImpl?: FetchLike; keys: MokshaKeys; registrar: Registrar; state: MokshaState }) {
    this.config = opts.config;
    this.fetchImpl = opts.fetchImpl ?? ((url, init) => fetch(url, init));
    this.keys = opts.keys;
    this.registrar = opts.registrar;
    this.state = opts.state;
  }

  async prepare(read: PaidRead): Promise<{ amount: string; bodyJson: string }> {
    if (!BYTES32_RE.test(read.readId)) {
      throw new Error(`readId must be bytes32 hex: ${read.readId}`);
    }
    const readId = read.readId.toLowerCase();
    if (this.state.paidReadCount() >= this.config.maxPaidReads) {
      this.state.data.payments[readId] = {
        acceptedAt: null,
        amountWei: "0",
        childId: read.childId,
        explorerUrl: null,
        nonce: "0",
        opId: readId,
        opType: "data_access",
        preparedAt: this.state.nowIso(),
        readId,
        response: { error: `paid-read cap ${this.config.maxPaidReads} reached` },
        settleBlock: null,
        settledAt: null,
        settleTxHash: null,
        status: "capped",
      };
      this.state.save();
      const capped: MokshaBody = { capped: true, meta: { childId: read.childId, opType: "data_access", readId } };
      return { amount: "0", bodyJson: JSON.stringify(capped) };
    }

    const child = await this.registrar.ensureChild(read.childId);
    if (!(child.grantId && child.dataVersion)) {
      throw new Error(`child ${read.childId} is not fully registered`);
    }
    const grantForm = !child.grantPaid && (child.grantPaymentReadId === null || child.grantPaymentReadId === readId);
    const fees = this.config.fees;
    const amount = grantForm ? fees.grantRegistrationWei + fees.dataAccessWei : fees.dataAccessWei;
    const opType = grantForm ? "grant" : "data_access";
    const opId = (grantForm ? child.grantId : readId) as Hex;
    if (grantForm) {
      child.grantPaymentReadId = readId;
    }
    const nonce = this.state.nextNonce();
    const signed = await signGatewayPayment({
      amountWei: amount.toString(),
      asset: this.config.asset,
      builder: this.keys.builder,
      chainId: this.config.chainId,
      dataOwnerAddress: child.ownerAddress,
      dataPointScope: this.config.scope,
      dataPointVersion: BigInt(child.dataVersion),
      dataRegistryContract: this.config.contracts.dataRegistry,
      escrowContract: this.config.contracts.escrow,
      opId,
      opType,
      paymentNonce: nonce,
      recordId: readId as Hex,
      server: this.keys.childServer(read.childId),
    });
    this.state.data.payments[readId] = {
      acceptedAt: null,
      amountWei: amount.toString(),
      childId: read.childId,
      explorerUrl: null,
      nonce: nonce.toString(),
      opId,
      opType,
      preparedAt: this.state.nowIso(),
      readId,
      response: null,
      settleBlock: null,
      settledAt: null,
      settleTxHash: null,
      status: "prepared",
    };
    this.state.save();
    const out: MokshaBody = { ...signed, meta: { childId: read.childId, opType, readId } };
    return { amount: amount.toString(), bodyJson: JSON.stringify(out) };
  }

  async send(bodyJson: string): Promise<SendResult> {
    const parsed = JSON.parse(bodyJson) as MokshaBody;
    if (parsed.capped || !parsed.authorization) {
      return { accepted: false, response: { error: "paid-read cap reached; not sent" }, retryable: false };
    }
    this.sendCalls += 1;
    const result = await postEscrowPay({
      authorization: parsed.authorization,
      body: parsed.body,
      fetchImpl: this.fetchImpl,
      gatewayUrl: this.config.gatewayUrl,
    });
    const { childId, opType, readId } = parsed.meta;
    const payment = this.state.data.payments[readId];
    const child = this.state.data.children[childId];
    const status = (result.response as { status?: number }).status;
    const errBody = (result.response as { body?: { breakdown?: { registrationAlreadyPaid?: boolean } } }).body;
    let out = result;
    if (result.accepted) {
      if (payment) {
        payment.status = "accepted";
        payment.acceptedAt ??= this.state.nowIso();
        payment.response = result.response;
      }
      if (opType === "grant" && child) {
        child.grantPaid = true;
      }
    } else if (!result.retryable) {
      const waitingOnGrant = opType === "data_access" && status === 403 && child && !child.grantPaid && child.grantPaymentReadId !== null;
      if (status === 402 || waitingOnGrant) {
        // 402: escrow balance not finalized yet; 403: this child's grant
        // payment is still pending. The same signed body stays valid; the
        // reminder service resends pending payments on its daily run.
        out = { ...result, retryable: true };
      } else {
        if (payment) {
          payment.status = "rejected";
          payment.response = result.response;
        }
        if (opType === "grant" && child) {
          child.grantPaymentReadId = null;
          if (errBody?.breakdown?.registrationAlreadyPaid === true) {
            child.grantPaid = true;
          }
        }
      }
    }
    if (payment && !result.accepted) {
      payment.response = result.response;
    }
    this.state.save();
    return out;
  }
}
