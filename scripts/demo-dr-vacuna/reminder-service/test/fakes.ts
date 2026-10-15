// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// In-process fakes for the reminder-service tests: a PDPP AS/RS (refresh
// rotation with family revocation on replay, record reads with signed
// receipts, the PR #401 lifecycle operation) and a data-gateway escrow/pay
// endpoint that verifies the EIP-712 signatures. Loopback only.

import { createHash, generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { getAddress, type Hex, recoverTypedDataAddress } from "viem";
import { computeDataPointId, GENERIC_PAYMENT_TYPES, RECORD_DATA_ACCESS_TYPES, vanaDomain } from "../lib/payer.ts";

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of req) {
    chunks.push(c as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json", ...headers });
  res.end(text);
}

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

export interface FakeGrant {
  childId: string;
  disposition: "keep" | "delete" | null;
  endedAt: string | null;
  grantId: string;
  instructionId: string | null;
  revoked: boolean;
}

interface RefreshEntry {
  family: string;
  grantId: string;
  state: "active" | "superseded" | "revoked";
}

export class FakePdpp {
  readonly grants = new Map<string, FakeGrant>();
  readonly accessTokens = new Map<string, string>(); // token -> grantId
  readonly refreshTokens = new Map<string, RefreshEntry>();
  readonly refreshCalls: string[] = []; // presented refresh tokens, in order
  readonly lifecycleReports: Record<string, string>[] = [];
  readonly records = new Map<string, Record<string, unknown>>();
  readonly receiptKeys = generateKeyPairSync("ed25519");
  lifecycleQueries = 0;
  /** When set, the next refresh rotates server-side and then drops the connection. */
  dropNextRefreshResponse = false;
  now: () => number = Date.now;
  url = "";
  private server: Server | null = null;

  addChild(childId: string, record: Record<string, unknown>): { accessToken: string; grantId: string; refreshToken: string } {
    const grantId = `grt_${randomBytes(6).toString("hex")}`;
    this.grants.set(grantId, { childId, disposition: null, endedAt: null, grantId, instructionId: null, revoked: false });
    this.records.set(childId, record);
    const accessToken = randomBytes(16).toString("hex");
    const refreshToken = `rt_${randomBytes(16).toString("hex")}`;
    this.accessTokens.set(accessToken, grantId);
    this.refreshTokens.set(refreshToken, { family: grantId, grantId, state: "active" });
    return { accessToken, grantId, refreshToken };
  }

  revoke(grantId: string, disposition: "keep" | "delete"): void {
    const g = this.grants.get(grantId) as FakeGrant;
    g.revoked = true;
    g.disposition = disposition;
    g.endedAt = new Date(this.now()).toISOString();
    g.instructionId = disposition === "delete" ? `ei_${randomBytes(4).toString("hex")}` : null;
  }

  async start(): Promise<void> {
    this.server = createServer((req, res) => {
      this.handle(req, res).catch((err) => send(res, 500, { error: String(err) }));
    });
    this.url = await listen(this.server);
  }

  async stop(): Promise<void> {
    this.server?.closeAllConnections();
    await new Promise((resolve) => this.server?.close(resolve));
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", this.url);
    if (req.method === "POST" && url.pathname === "/oauth/token") {
      const form = new URLSearchParams(await readBody(req));
      if (!form.get("client_assertion")) {
        return send(res, 401, { error: "invalid_client" });
      }
      const presented = form.get("refresh_token") ?? "";
      this.refreshCalls.push(presented);
      const entry = this.refreshTokens.get(presented);
      if (!entry || entry.state !== "active") {
        if (entry) {
          for (const e of this.refreshTokens.values()) {
            if (e.family === entry.family) {
              e.state = "revoked";
            }
          }
        }
        return send(res, 400, { error: "invalid_grant" });
      }
      const grant = this.grants.get(entry.grantId) as FakeGrant;
      if (grant.revoked) {
        return send(res, 400, { error: "invalid_grant" });
      }
      entry.state = "superseded";
      const next = `rt_${randomBytes(16).toString("hex")}`;
      this.refreshTokens.set(next, { family: entry.family, grantId: entry.grantId, state: "active" });
      const access = randomBytes(16).toString("hex");
      this.accessTokens.set(access, entry.grantId);
      if (this.dropNextRefreshResponse) {
        this.dropNextRefreshResponse = false;
        req.socket.destroy();
        return;
      }
      return send(res, 200, { access_token: access, expires_in: 900, grant_id: entry.grantId, refresh_token: next, token_type: "Bearer" });
    }
    const recordMatch = /^\/v1\/streams\/([^/]+)\/records\/([^/]+)$/.exec(url.pathname);
    if (req.method === "GET" && recordMatch) {
      const token = (req.headers.authorization ?? "").replace(/^Bearer /, "");
      const grantId = this.accessTokens.get(token);
      const grant = grantId ? this.grants.get(grantId) : undefined;
      if (!grant) {
        return send(res, 401, { error: { code: "authentication_error" } }, { "WWW-Authenticate": 'Bearer error="invalid_token"' });
      }
      if (grant.revoked) {
        return send(res, 403, { error: { code: "grant_revoked" } });
      }
      const childId = decodeURIComponent(recordMatch[2] as string);
      if (childId !== grant.childId) {
        return send(res, 404, { error: { code: "not_found" } });
      }
      const text = JSON.stringify({ data: this.records.get(childId), id: childId, object: "record" });
      const header = Buffer.from(JSON.stringify({ alg: "EdDSA", typ: "pdpp-read-receipt+jws" })).toString("base64url");
      const payload = Buffer.from(
        JSON.stringify({
          grant_id: grant.grantId,
          read_id: `0x${randomBytes(32).toString("hex")}`,
          record_sha256: createHash("sha256").update(text).digest("hex"),
          request_id: `req_${randomBytes(4).toString("hex")}`,
          served_at: new Date().toISOString(),
          v: 1,
        })
      ).toString("base64url");
      const sig = sign(null, Buffer.from(`${header}.${payload}`), this.receiptKeys.privateKey).toString("base64url");
      res.writeHead(200, { "Content-Type": "application/json", "PDPP-Read-Receipt": `${header}.${payload}.${sig}` });
      res.end(text);
      return;
    }
    if (req.method === "POST" && url.pathname === "/oauth/grant-lifecycle") {
      const form = new URLSearchParams(await readBody(req));
      if (!form.get("client_assertion")) {
        return send(res, 401, { error: "invalid_client" });
      }
      if (form.get("report")) {
        this.lifecycleReports.push(Object.fromEntries(form.entries()));
        return send(res, 200, { grants: [] });
      }
      this.lifecycleQueries += 1;
      const assessedAt = new Date(this.now()).toISOString();
      const grants = form.getAll("grant_id").map((id) => {
        const g = this.grants.get(id);
        if (!g) {
          return { error: "invalid_grant", grant_id: id };
        }
        const erase = g.revoked && g.disposition === "delete";
        return {
          assessed_at: assessedAt,
          grant_id: id,
          held_data: erase ? "erase" : "permitted",
          read_state: g.revoked ? "revoked" : "active",
          ...(g.endedAt ? { ended_at: g.endedAt } : {}),
          ...(erase
            ? {
                erasure: {
                  accepted_at: g.endedAt,
                  effective_at: g.endedAt,
                  instruction_id: g.instructionId,
                  stop_use_by: new Date(Date.parse(g.endedAt as string) + 48 * 3_600_000).toISOString(),
                },
              }
            : {}),
        };
      });
      return send(res, 200, { grants });
    }
    send(res, 404, { error: "not_found" });
  }
}

export interface GatewayFakeConfig {
  chainId: bigint;
  dataOwnerAddress: string;
  dataPointScope: string;
  dataRegistryContract: string;
  escrowContract: string;
  trustedServer: string;
}

/** Verifies POST /v1/escrow/pay like data-gateway does (signatures, opId/accessor binding, idempotency). */
export class FakeGateway {
  readonly accepted = new Map<string, Record<string, unknown>>(); // recordId -> body
  readonly calls: { status: number; body: unknown }[] = [];
  url = "";
  private server: Server | null = null;
  private readonly usedNonces = new Set<string>();
  private readonly config: GatewayFakeConfig;
  constructor(config: GatewayFakeConfig) {
    this.config = config;
  }

  async start(): Promise<void> {
    this.server = createServer((req, res) => {
      this.handle(req, res).catch((err) => send(res, 500, { error: String(err), success: false }));
    });
    this.url = await listen(this.server);
  }

  async stop(): Promise<void> {
    this.server?.closeAllConnections();
    await new Promise((resolve) => this.server?.close(resolve));
  }

  private reply(res: ServerResponse, status: number, body: Record<string, unknown>): void {
    this.calls.push({ body, status });
    send(res, status, body);
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== "POST" || req.url !== "/v1/escrow/pay") {
      return this.reply(res, 404, { success: false });
    }
    const body = JSON.parse(await readBody(req)) as Record<string, string> & { accessRecord: Record<string, string> };
    const auth = String(req.headers.authorization ?? "");
    if (!auth.startsWith("Web3Signed ")) {
      return this.reply(res, 401, { error: "missing signature", success: false });
    }
    const c = this.config;
    const signer = await recoverTypedDataAddress({
      domain: vanaDomain(c.chainId, c.escrowContract),
      message: {
        amount: BigInt(body.amount as string),
        asset: getAddress(body.asset as string),
        opId: body.opId as Hex,
        opType: body.opType as string,
        payerAddress: getAddress(body.payerAddress as string),
        paymentNonce: BigInt(body.paymentNonce as string),
      },
      primaryType: "GenericPayment",
      signature: auth.slice("Web3Signed ".length) as Hex,
      types: GENERIC_PAYMENT_TYPES,
    });
    if (signer.toLowerCase() !== String(body.payerAddress).toLowerCase()) {
      return this.reply(res, 401, { error: "Invalid signature: signer does not match payerAddress", success: false });
    }
    const ar = body.accessRecord;
    if (body.opType !== "data_access" || body.opId?.toLowerCase() !== ar.recordId?.toLowerCase()) {
      return this.reply(res, 400, { error: "opId must equal accessRecord.recordId for opType=data_access", success: false });
    }
    if (ar.accessor?.toLowerCase() !== String(body.payerAddress).toLowerCase()) {
      return this.reply(res, 400, { error: "accessRecord.accessor must equal payerAddress", success: false });
    }
    if (ar.dataPointId !== computeDataPointId(c.dataOwnerAddress, c.dataPointScope)) {
      return this.reply(res, 400, { error: "accessRecord.dataPointId not found in gateway", success: false });
    }
    const server = await recoverTypedDataAddress({
      domain: vanaDomain(c.chainId, c.dataRegistryContract),
      message: {
        accessor: getAddress(ar.accessor),
        ownerAddress: getAddress(c.dataOwnerAddress),
        recordId: ar.recordId as Hex,
        scope: c.dataPointScope,
        version: BigInt(ar.version as string),
      },
      primaryType: "RecordDataAccess",
      signature: ar.signature as Hex,
      types: RECORD_DATA_ACCESS_TYPES,
    });
    if (server.toLowerCase() !== c.trustedServer.toLowerCase()) {
      return this.reply(res, 401, { error: "accessRecord.signature signer is not a trusted server", success: false });
    }
    const prior = this.accepted.get(ar.recordId.toLowerCase());
    if (prior) {
      const same = prior.paymentNonce === body.paymentNonce && prior.signature === auth;
      return same
        ? this.reply(res, 200, { opId: body.opId, paymentNonce: body.paymentNonce, success: true })
        : this.reply(res, 409, { error: "accessRecord.recordId is already paid", success: false });
    }
    const nonceKey = `${body.payerAddress?.toLowerCase()}:${body.paymentNonce}`;
    if (this.usedNonces.has(nonceKey)) {
      return this.reply(res, 409, { error: "paymentNonce already used by this payer", success: false });
    }
    this.usedNonces.add(nonceKey);
    this.accepted.set(ar.recordId.toLowerCase(), { ...body, signature: auth });
    return this.reply(res, 200, {
      amount: body.amount,
      opId: body.opId,
      opType: body.opType,
      paidAt: new Date().toISOString(),
      paymentNonce: body.paymentNonce,
      success: true,
    });
  }
}
