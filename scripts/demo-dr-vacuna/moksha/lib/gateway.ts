// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// data-gateway client for the registration, deposit and read endpoints the
// Moksha run uses. Write endpoints take `Authorization: Web3Signed <EIP-712
// signature>` over the body's typed struct (data-gateway lib/auth.ts).
// Request/response shapes follow data-gateway api/v1/**; see SEQUENCE.md.

import { getAddress, type Hex } from "viem";
import type { LocalAccount } from "viem/accounts";
import type { FetchLike } from "../../reminder-service/lib/oauth.ts";
import type { MokshaConfig } from "./config.ts";
import {
  ADD_DATA_TYPES,
  BUILDER_REGISTRATION_TYPES,
  GRANT_REGISTRATION_TYPES,
  SERVER_REGISTRATION_TYPES,
  vanaDomain,
} from "./typed-data.ts";

export interface GatewayResponse<T = Record<string, unknown>> {
  body: T;
  status: number;
}

export class GatewayClient {
  readonly config: MokshaConfig;
  private readonly fetchImpl: FetchLike;

  constructor(config: MokshaConfig, fetchImpl?: FetchLike) {
    this.config = config;
    this.fetchImpl = fetchImpl ?? ((url, init) => fetch(url, init));
  }

  async request<T = Record<string, unknown>>(
    method: "GET" | "POST",
    path: string,
    opts: { body?: unknown; signature?: Hex } = {}
  ): Promise<GatewayResponse<T>> {
    const headers: Record<string, string> = { Accept: "application/json" };
    if (opts.body !== undefined) {
      headers["Content-Type"] = "application/json";
    }
    if (opts.signature) {
      headers.Authorization = `Web3Signed ${opts.signature}`;
    }
    const resp = await this.fetchImpl(`${this.config.gatewayUrl}${path}`, {
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      headers,
      method,
      signal: AbortSignal.timeout(30_000),
    });
    const text = await resp.text();
    let body: unknown = text;
    try {
      body = JSON.parse(text);
    } catch {
      // non-JSON error page
    }
    return { body: body as T, status: resp.status };
  }

  /** POST /v1/builders, signed by the builder's owner (here the builder key itself). */
  async registerBuilder(owner: LocalAccount, grantee: LocalAccount, appUrl: string) {
    const body = {
      appUrl,
      granteeAddress: grantee.address,
      ownerAddress: owner.address,
      publicKey: grantee.publicKey,
    };
    const signature = await owner.signTypedData({
      domain: vanaDomain(this.config.chainId, this.config.contracts.grantees),
      message: { ...body, granteeAddress: getAddress(body.granteeAddress), ownerAddress: getAddress(body.ownerAddress) },
      primaryType: "BuilderRegistration",
      types: BUILDER_REGISTRATION_TYPES,
    });
    return this.request<{ builderId?: string; error?: string; success?: boolean }>("POST", "/v1/builders", { body, signature });
  }

  getBuilder(address: string) {
    return this.request<{ data?: { id: string; granteeAddress: string } }>("GET", `/v1/builders/${address}`);
  }

  /** POST /v1/servers, signed by the data owner (the child). */
  async registerServer(owner: LocalAccount, server: LocalAccount, serverUrl: string) {
    const body = { ownerAddress: owner.address, publicKey: server.publicKey, serverAddress: server.address, serverUrl };
    const signature = await owner.signTypedData({
      domain: vanaDomain(this.config.chainId, this.config.contracts.servers),
      message: body,
      primaryType: "ServerRegistration",
      types: SERVER_REGISTRATION_TYPES,
    });
    return this.request<{ error?: string; serverId?: string; success?: boolean }>("POST", "/v1/servers", { body, signature });
  }

  getServer(address: string) {
    return this.request<{ data?: { id: string; ownerAddress: string; revokedAt: string | null; serverAddress: string } }>(
      "GET",
      `/v1/servers/${address}`
    );
  }

  /** POST /v1/data (AddData), signed by the owner or one of its registered servers. */
  async addData(
    signer: LocalAccount,
    p: { dataHash: Hex; expectedVersion: bigint; metadataHash: Hex; ownerAddress: string; scope: string }
  ) {
    const body = {
      dataHash: p.dataHash,
      expectedVersion: p.expectedVersion.toString(),
      metadataHash: p.metadataHash,
      ownerAddress: getAddress(p.ownerAddress),
      scope: p.scope,
    };
    const signature = await signer.signTypedData({
      domain: vanaDomain(this.config.chainId, this.config.contracts.dataRegistry),
      message: { ...body, expectedVersion: p.expectedVersion },
      primaryType: "AddData",
      types: ADD_DATA_TYPES,
    });
    return this.request<{ dataPointId?: string; error?: string; expectedVersion?: string; success?: boolean }>(
      "POST",
      "/v1/data",
      { body, signature }
    );
  }

  getDataPoint(dataPointId: string) {
    return this.request<{ data?: { expectedVersion: string; id: string; ownerAddress: string; scope: string } }>(
      "GET",
      `/v1/data/${dataPointId}`
    );
  }

  /** POST /v1/grants, signed by the grantor (the child) or one of its registered servers. */
  async registerGrant(
    grantor: LocalAccount,
    p: { expiresAt: bigint; grantVersion: bigint; granteeId: Hex; scopes: string[] }
  ) {
    const body = {
      expiresAt: p.expiresAt.toString(),
      grantVersion: p.grantVersion.toString(),
      granteeId: p.granteeId,
      grantorAddress: grantor.address,
      scopes: p.scopes,
    };
    const signature = await grantor.signTypedData({
      domain: vanaDomain(this.config.chainId, this.config.contracts.permissions),
      message: {
        expiresAt: p.expiresAt,
        grantVersion: p.grantVersion,
        granteeId: p.granteeId,
        grantorAddress: grantor.address,
        scopes: p.scopes,
      },
      primaryType: "GrantRegistration",
      types: GRANT_REGISTRATION_TYPES,
    });
    return this.request<{ currentGrantVersion?: string; error?: string; grantId?: string; grantVersion?: string; success?: boolean }>(
      "POST",
      "/v1/grants",
      { body, signature }
    );
  }

  /** GET /v1/grants?user=&builder= — the grant between one grantor and one builder, with its fee. */
  listGrants(user: string, builder: string) {
    return this.request<{ data?: { grants: GatewayGrant[] } }>(
      "GET",
      `/v1/grants?user=${getAddress(user)}&builder=${getAddress(builder)}`
    );
  }

  getBalance(account: string) {
    return this.request<GatewayBalance>("GET", `/v1/escrow/balance?account=${getAddress(account)}`);
  }

  submitDeposit(txHash: string) {
    return this.request<{ account?: string; error?: string; status?: string; success?: boolean; txHash?: string }>(
      "POST",
      "/v1/escrow/deposit",
      { body: { txHash } }
    );
  }
}

export interface GatewayGrant {
  fee: { asset: string; dataAccessFee: string; registrationFee: string; totalDue: string };
  grantVersion: string;
  grantorAddress: string;
  granteeId: string;
  id: string;
  paymentStatus: string;
  revokedAt: string | null;
  scopes: string[];
  settleTxHash: string | null;
  status: string;
}

export interface GatewayBalance {
  account: string;
  balances: {
    asset: string;
    authorizedAmount: string;
    availableAmount: string;
    balance: string;
    pendingAmount: string;
  }[];
  deposits: { failed: unknown[]; finalized: unknown[]; submitted: unknown[] };
}
