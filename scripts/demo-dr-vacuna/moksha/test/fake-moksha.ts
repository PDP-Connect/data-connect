// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Local fake of the data-gateway endpoints the Moksha run uses, plus a fake
// chain JSON-RPC. Loopback only. It checks what the real handlers check
// (data-gateway api/v1/**): exact body fields, every EIP-712 signature
// against its endpoint's domain, owner/server authorization, version and
// grantVersion rules, fee totals, soft-locked balance, nonce replay and
// recordId idempotency. `settle()` plays the relayer: one
// recordAccessAndSettle tx per paid read with its Settled event.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import {
  decodeFunctionData,
  encodeAbiParameters,
  encodeEventTopics,
  encodeFunctionData,
  getAddress,
  type Hex,
  keccak256,
  parseTransaction,
  recoverTransactionAddress,
  recoverTypedDataAddress,
  toHex,
} from "viem";
import { publicKeyToAddress } from "viem/accounts";
import type { MokshaConfig } from "../lib/config.ts";
import { ESCROW_DEPOSIT_ABI } from "../lib/deposit.ts";
import { OP_KIND, RECORD_ACCESS_AND_SETTLE_ABI, SETTLED_EVENT_ABI } from "../lib/settlement.ts";
import {
  ADD_DATA_TYPES,
  BUILDER_REGISTRATION_TYPES,
  computeDataPointId,
  GENERIC_PAYMENT_TYPES,
  GRANT_REGISTRATION_TYPES,
  RECORD_DATA_ACCESS_TYPES,
  SERVER_REGISTRATION_TYPES,
  vanaDomain,
} from "../lib/typed-data.ts";

const SIG_RE = /^0x[0-9a-fA-F]{130}$/;
const BYTES32_RE = /^0x[0-9a-fA-F]{64}$/;
const PUBKEY_RE = /^0x04[0-9a-fA-F]{128}$/;
const PAYEE = "0x000000000000000000000000000000000000fee5";
const GAS_PRICE = 1_000_000_000n;
const GAS = 90_000n;

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of req) {
    chunks.push(c as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

const lc = (s: string) => s.toLowerCase();

interface Payment {
  accessRecord: { accessor: string; dataPointId: string; recordId: string; signature: string; version: string };
  amount: bigint;
  dataAccessFee: bigint;
  grantId: string;
  nonce: string;
  opId: string;
  opType: string;
  payer: string;
  registrationFee: bigint;
  serverSignature: string;
  settled: boolean;
  signature: string;
}

interface ChainTx {
  from: string;
  hash: Hex;
  input: Hex;
  to: string;
  value: bigint;
}

interface ChainLog {
  address: string;
  blockNumber: bigint;
  data: Hex;
  topics: Hex[];
  transactionHash: Hex;
}

export class FakeMoksha {
  readonly calls: { body: unknown; method: string; path: string; request: unknown; status: number }[] = [];
  readonly builders = new Map<string, { appUrl: string; grantee: string; id: string; owner: string }>();
  readonly servers = new Map<string, { id: string; owner: string; serverAddress: string; serverUrl: string }>();
  readonly dataPoints = new Map<string, { owner: string; scope: string; versions: Map<string, { status: string }> }>();
  readonly grants = new Map<
    string,
    { grantVersion: bigint; grantee: string; grantor: string; id: string; paymentStatus: string; revoked: boolean; scopes: string[]; settleTxHash: string | null; status: string }
  >();
  readonly payments = new Map<string, Payment>(); // recordId -> payment
  readonly deposits = new Map<string, { account: string; amount: bigint; status: string }>();
  readonly balances = new Map<string, bigint>();
  readonly nonces = new Set<string>();
  // chain
  readonly txs = new Map<string, ChainTx>();
  readonly logs: ChainLog[] = [];
  readonly native = new Map<string, bigint>();
  readonly relayer = "0x000000000000000000000000000000000000beef";
  blockNumber = 1000n;
  gatewayUrl = "";
  rpcUrl = "";
  rpcCalls: string[] = [];
  private readonly config: MokshaConfig;
  private gatewayServer: Server | null = null;
  private rpcServer: Server | null = null;

  constructor(config: MokshaConfig) {
    this.config = config;
  }

  async start(): Promise<void> {
    this.gatewayServer = createServer((req, res) => {
      this.handleGateway(req, res).catch((err) => this.reply(res, req, null, 500, { error: String(err), success: false }));
    });
    this.rpcServer = createServer((req, res) => {
      this.handleRpc(req, res).catch((err) => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { code: -32000, message: String((err as Error).message) }, id: 0, jsonrpc: "2.0" }));
      });
    });
    this.gatewayUrl = await listen(this.gatewayServer);
    this.rpcUrl = await listen(this.rpcServer);
  }

  async stop(): Promise<void> {
    for (const s of [this.gatewayServer, this.rpcServer]) {
      s?.closeAllConnections();
      await new Promise((resolve) => s?.close(resolve));
    }
  }

  fund(address: string, wei: bigint): void {
    this.native.set(lc(address), (this.native.get(lc(address)) ?? 0n) + wei);
  }

  /** Calls with a given method + path prefix. */
  posts(path: string): { body: unknown; request: unknown; status: number }[] {
    return this.calls.filter((c) => c.method === "POST" && c.path === path);
  }

  private reply(res: ServerResponse, req: IncomingMessage, request: unknown, status: number, body: unknown): void {
    this.calls.push({ body, method: req.method ?? "", path: (req.url ?? "").split("?")[0] as string, request, status });
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  }

  private domain(contract: string) {
    return vanaDomain(this.config.chainId, contract);
  }

  private authSig(req: IncomingMessage): Hex | null {
    const h = String(req.headers.authorization ?? "");
    if (!h.startsWith("Web3Signed ")) {
      return null;
    }
    const sig = h.slice("Web3Signed ".length);
    return SIG_RE.test(sig) ? (sig as Hex) : null;
  }

  private isOwnerOrServer(owner: string, signer: string): boolean {
    if (lc(owner) === lc(signer)) {
      return true;
    }
    const s = this.servers.get(lc(signer));
    return Boolean(s && lc(s.owner) === lc(owner));
  }

  private async handleGateway(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://x");
    const path = url.pathname;
    let body: Record<string, unknown> = {};
    if (req.method === "POST") {
      const raw = await readBody(req);
      body = (raw ? JSON.parse(raw) : {}) as Record<string, unknown>;
    }
    const r = (status: number, out: unknown) => this.reply(res, req, body, status, out);
    const exactKeys = (required: string[], optional: string[] = []) => {
      const keys = Object.keys(body);
      const missing = required.filter((k) => body[k] === undefined || body[k] === "");
      const extra = keys.filter((k) => !required.includes(k) && !optional.includes(k));
      return missing.length || extra.length ? `fields: missing [${missing}] extra [${extra}]` : null;
    };

    if (req.method === "POST" && path === "/v1/builders") {
      const bad = exactKeys(["ownerAddress", "granteeAddress", "publicKey"], ["appUrl"]);
      if (bad) return r(400, { error: bad, success: false });
      const sig = this.authSig(req);
      if (!sig) return r(401, { error: "Missing Authorization header", success: false });
      const publicKey = String(body.publicKey);
      if (!PUBKEY_RE.test(publicKey) || lc(publicKeyToAddress(publicKey as Hex)) !== lc(String(body.granteeAddress))) {
        return r(400, { error: "Invalid publicKey", success: false });
      }
      const message = {
        appUrl: String(body.appUrl ?? ""),
        granteeAddress: getAddress(String(body.granteeAddress)),
        ownerAddress: getAddress(String(body.ownerAddress)),
        publicKey,
      };
      const signer = await recoverTypedDataAddress({
        domain: this.domain(this.config.contracts.grantees),
        message,
        primaryType: "BuilderRegistration",
        signature: sig,
        types: BUILDER_REGISTRATION_TYPES,
      });
      if (lc(signer) !== lc(message.ownerAddress)) return r(401, { error: "Invalid signature: signature verification failed", success: false });
      if (this.builders.has(lc(message.granteeAddress))) {
        return r(409, { error: "Builder already registered: this granteeAddress is already registered", success: false });
      }
      const id = keccak256(encodeAbiParameters([{ type: "address" }, { type: "address" }, { type: "string" }, { type: "string" }], [message.ownerAddress, message.granteeAddress, publicKey, message.appUrl]));
      this.builders.set(lc(message.granteeAddress), { appUrl: message.appUrl, grantee: message.granteeAddress, id, owner: message.ownerAddress });
      return r(201, { builderId: id, success: true });
    }
    if (req.method === "GET" && path.startsWith("/v1/builders/")) {
      const b = this.builders.get(lc(path.slice("/v1/builders/".length)));
      return b ? r(200, { data: { granteeAddress: b.grantee, id: b.id, ownerAddress: b.owner }, proof: {} }) : r(404, { error: "Builder not found" });
    }

    if (req.method === "POST" && path === "/v1/servers") {
      const bad = exactKeys(["ownerAddress", "serverAddress", "publicKey", "serverUrl"]);
      if (bad) return r(400, { error: bad, success: false });
      const sig = this.authSig(req);
      if (!sig) return r(401, { error: "Missing Authorization header", success: false });
      const publicKey = String(body.publicKey);
      if (!PUBKEY_RE.test(publicKey) || lc(publicKeyToAddress(publicKey as Hex)) !== lc(String(body.serverAddress))) {
        return r(400, { error: "Invalid publicKey: public key does not correspond to serverAddress", success: false });
      }
      const message = {
        ownerAddress: getAddress(String(body.ownerAddress)),
        publicKey,
        serverAddress: getAddress(String(body.serverAddress)),
        serverUrl: String(body.serverUrl),
      };
      const signer = await recoverTypedDataAddress({
        domain: this.domain(this.config.contracts.servers),
        message,
        primaryType: "ServerRegistration",
        signature: sig,
        types: SERVER_REGISTRATION_TYPES,
      });
      if (lc(signer) !== lc(message.ownerAddress)) {
        return r(401, { details: { expectedSigner: message.ownerAddress, recoveredSigner: signer }, error: "Invalid signature: signature verification failed", success: false });
      }
      const existing = this.servers.get(lc(message.serverAddress));
      if (existing) {
        return lc(existing.owner) === lc(message.ownerAddress)
          ? r(409, { error: "Server already registered: this serverAddress is already registered", success: false })
          : r(403, { error: "Forbidden: this serverAddress was registered by a different owner", success: false });
      }
      const id = keccak256(encodeAbiParameters([{ type: "address" }, { type: "string" }, { type: "string" }], [message.serverAddress, publicKey, message.serverUrl]));
      this.servers.set(lc(message.serverAddress), { id, owner: message.ownerAddress, serverAddress: message.serverAddress, serverUrl: message.serverUrl });
      return r(201, { serverId: id, success: true });
    }
    if (req.method === "GET" && path.startsWith("/v1/servers/")) {
      const s = this.servers.get(lc(path.slice("/v1/servers/".length)));
      return s ? r(200, { data: { id: s.id, ownerAddress: s.owner, revokedAt: null, serverAddress: s.serverAddress, serverUrl: s.serverUrl }, proof: {} }) : r(404, { error: "Server not found" });
    }

    if (req.method === "POST" && path === "/v1/data") {
      const bad = exactKeys(["ownerAddress", "scope", "dataHash", "metadataHash", "expectedVersion"]);
      if (bad) return r(400, { error: bad, success: false });
      if (!BYTES32_RE.test(String(body.dataHash)) || !BYTES32_RE.test(String(body.metadataHash)) || !/^[1-9]\d*$/.test(String(body.expectedVersion))) {
        return r(400, { error: "Invalid hash or version", success: false });
      }
      const sig = this.authSig(req);
      if (!sig) return r(401, { error: "Missing Authorization header", success: false });
      const owner = getAddress(String(body.ownerAddress));
      const scope = String(body.scope);
      const version = BigInt(String(body.expectedVersion));
      const signer = await recoverTypedDataAddress({
        domain: this.domain(this.config.contracts.dataRegistry),
        message: { dataHash: body.dataHash as Hex, expectedVersion: version, metadataHash: body.metadataHash as Hex, ownerAddress: owner, scope },
        primaryType: "AddData",
        signature: sig,
        types: ADD_DATA_TYPES,
      });
      if (!this.isOwnerOrServer(owner, signer)) {
        return r(401, { error: `Invalid signature: signer ${signer} is not ownerAddress ${owner} or a registered server`, success: false });
      }
      const id = computeDataPointId(owner, scope);
      const dp = this.dataPoints.get(id) ?? { owner, scope, versions: new Map() };
      const max = [...dp.versions.keys()].reduce((m, v) => (BigInt(v) > m ? BigInt(v) : m), 0n);
      const slot = dp.versions.get(version.toString());
      if (slot && slot.status !== "pending") {
        return r(409, { error: `Stale expectedVersion ${version}`, nextExpectedVersion: (max + 1n).toString(), success: false });
      }
      if (!slot && version !== max + 1n) {
        return r(409, { error: `Gap in version sequence: next valid version is ${max + 1n}`, success: false });
      }
      dp.versions.set(version.toString(), { status: "pending" });
      this.dataPoints.set(id, dp);
      return r(201, { dataPointId: id, deletedAt: null, expectedVersion: version.toString(), lineage: null, success: true });
    }
    if (req.method === "GET" && path.startsWith("/v1/data/")) {
      const id = lc(path.slice("/v1/data/".length));
      const dp = this.dataPoints.get(id as Hex);
      if (!dp) return r(404, { error: "Data point not found" });
      const max = [...dp.versions.keys()].reduce((m, v) => (BigInt(v) > m ? BigInt(v) : m), 0n);
      return r(200, { data: { expectedVersion: max.toString(), id, ownerAddress: dp.owner, scope: dp.scope }, proof: {} });
    }

    if (req.method === "POST" && path === "/v1/grants") {
      const bad = exactKeys(["grantorAddress", "granteeId", "scopes", "grantVersion", "expiresAt"]);
      if (bad) return r(400, { error: bad, success: false });
      const sig = this.authSig(req);
      if (!sig) return r(401, { error: "Missing Authorization header", success: false });
      const granteeId = String(body.granteeId);
      if (![...this.builders.values()].some((b) => b.id === granteeId)) {
        return r(400, { error: "Invalid granteeId: builder does not exist", success: false });
      }
      const grantor = getAddress(String(body.grantorAddress));
      const scopes = body.scopes as string[];
      const grantVersion = BigInt(String(body.grantVersion));
      const signer = await recoverTypedDataAddress({
        domain: this.domain(this.config.contracts.permissions),
        message: { expiresAt: BigInt(String(body.expiresAt)), grantVersion, granteeId: granteeId as Hex, grantorAddress: grantor, scopes },
        primaryType: "GrantRegistration",
        signature: sig,
        types: GRANT_REGISTRATION_TYPES,
      });
      if (!this.isOwnerOrServer(grantor, signer)) {
        return r(401, { error: "Invalid signature: signer is not the grantor or an authorized server", success: false });
      }
      const id = keccak256(encodeAbiParameters([{ type: "address" }, { type: "bytes32" }], [grantor, granteeId as Hex]));
      const prior = this.grants.get(id);
      if (prior && prior.grantVersion >= grantVersion) {
        return r(409, { currentGrantVersion: prior.grantVersion.toString(), error: `Stale grantVersion ${grantVersion}`, success: false });
      }
      this.grants.set(id, { grantVersion, grantee: granteeId, grantor, id, paymentStatus: "pending", revoked: false, scopes, settleTxHash: null, status: "pending" });
      return r(prior ? 200 : 201, { grantId: id, grantVersion: grantVersion.toString(), overridden: Boolean(prior), success: true });
    }
    if (req.method === "GET" && path === "/v1/grants") {
      const user = lc(url.searchParams.get("user") ?? "");
      const builder = this.builders.get(lc(url.searchParams.get("builder") ?? ""));
      const fees = this.config.fees;
      const grants = [...this.grants.values()]
        .filter((g) => lc(g.grantor) === user && builder && g.grantee === builder.id)
        .map((g) => ({
          fee: {
            asset: this.config.asset,
            dataAccessFee: fees.dataAccessWei.toString(),
            registrationFee: fees.grantRegistrationWei.toString(),
            totalDue: ((g.paymentStatus === "paid" ? 0n : fees.grantRegistrationWei) + fees.dataAccessWei).toString(),
          },
          grantVersion: g.grantVersion.toString(),
          granteeId: g.grantee,
          grantorAddress: g.grantor,
          id: g.id,
          paymentStatus: g.paymentStatus,
          revokedAt: g.revoked ? new Date().toISOString() : null,
          scopes: g.scopes,
          settleTxHash: g.settleTxHash,
          status: g.status,
        }));
      return r(200, { data: { grants }, pagination: { hasMore: false, limit: 100, nextCursor: null }, proof: {} });
    }

    if (req.method === "POST" && path === "/v1/escrow/pay") {
      return this.pay(body, req, r);
    }
    if (req.method === "POST" && path === "/v1/escrow/deposit") {
      const bad = exactKeys(["txHash"]);
      if (bad) return r(400, { error: bad, success: false });
      const txHash = lc(String(body.txHash));
      const prior = this.deposits.get(txHash);
      if (prior) return r(200, { account: prior.account, status: prior.status, success: true, txHash });
      const tx = this.txs.get(txHash);
      if (!tx) return r(404, { error: "transaction not found by the RPC", success: false });
      if (lc(tx.to) !== lc(this.config.contracts.escrow)) return r(400, { error: "transaction is not addressed to the escrow contract", success: false });
      const call = decodeFunctionData({ abi: ESCROW_DEPOSIT_ABI, data: tx.input });
      const account = getAddress(call.args[0]);
      // The fake chain finalizes at once, so the deposit is credited here.
      this.deposits.set(txHash, { account, amount: tx.value, status: "finalized" });
      this.balances.set(lc(account), (this.balances.get(lc(account)) ?? 0n) + tx.value);
      return r(202, { account, status: "finalized", success: true, txHash });
    }
    // The real sync credits finalized deposits first; this fake credits them on
    // submission, so sync answers like the GET.
    if (
      (req.method === "GET" && path === "/v1/escrow/balance") ||
      (req.method === "POST" && path === "/v1/escrow/balance/sync")
    ) {
      const account = getAddress(url.searchParams.get("account") ?? "");
      const balance = this.balances.get(lc(account)) ?? 0n;
      const authorized = this.authorized(account);
      const available = balance > authorized ? balance - authorized : 0n;
      return r(200, {
        account,
        balances: [
          {
            asset: this.config.asset,
            authorizedAmount: authorized.toString(),
            availableAmount: available.toString(),
            balance: balance.toString(),
            pendingAmount: "0",
            updatedAt: null,
            withdrawalMinimumAmount: null,
            withdrawingAmount: "0",
          },
        ],
        deposits: { failed: [], finalized: [...this.deposits.keys()].map((txHash) => ({ txHash })), submitted: [] },
      });
    }
    return r(404, { error: "not found" });
  }

  private authorized(account: string): bigint {
    let sum = 0n;
    for (const p of this.payments.values()) {
      if (!p.settled && lc(p.payer) === lc(account)) {
        sum += p.amount;
      }
    }
    return sum;
  }

  private async pay(body: Record<string, unknown>, req: IncomingMessage, r: (s: number, b: unknown) => void): Promise<void> {
    for (const f of ["payerAddress", "opType", "opId", "asset", "amount", "paymentNonce"]) {
      if (typeof body[f] !== "string" || !body[f]) return r(400, { error: `Missing or invalid field: ${f}`, success: false });
    }
    const extra = Object.keys(body).filter((k) => !["payerAddress", "opType", "opId", "asset", "amount", "paymentNonce", "accessRecord"].includes(k));
    if (extra.length) return r(400, { error: `unexpected fields ${extra}`, success: false });
    const payer = getAddress(String(body.payerAddress));
    const opType = String(body.opType);
    const opId = lc(String(body.opId));
    if (!["grant", "data_access"].includes(opType)) return r(400, { error: "Invalid opType", success: false });
    const asset = getAddress(String(body.asset));
    const amount = BigInt(String(body.amount));
    const nonce = String(body.paymentNonce);
    const sig = this.authSig(req);
    if (!sig) return r(401, { error: "Missing Authorization header", success: false });
    const signer = await recoverTypedDataAddress({
      domain: this.domain(this.config.contracts.escrow),
      message: { amount, asset, opId: opId as Hex, opType, payerAddress: payer, paymentNonce: BigInt(nonce) },
      primaryType: "GenericPayment",
      signature: sig,
      types: GENERIC_PAYMENT_TYPES,
    });
    if (lc(signer) !== lc(payer)) return r(401, { error: "Invalid signature: signer does not match payerAddress", success: false });
    const ar = body.accessRecord as Payment["accessRecord"] | undefined;
    if (!ar) return r(400, { error: "accessRecord is required when dataAccessFee is greater than 0", success: false });
    const arKeys = Object.keys(ar).sort().join(",");
    if (arKeys !== "accessor,dataPointId,recordId,signature,version") return r(400, { error: `accessRecord fields ${arKeys}`, success: false });
    const recordId = lc(ar.recordId);
    if (opType === "data_access" && opId !== recordId) return r(400, { error: "opId must equal accessRecord.recordId for opType=data_access", success: false });
    if (opType === "data_access" && lc(ar.accessor) !== lc(payer)) return r(400, { error: "accessRecord.accessor must equal payerAddress", success: false });

    const prior = this.payments.get(recordId);
    if (prior) {
      const same = prior.signature === sig && prior.nonce === nonce && prior.amount === amount && lc(prior.payer) === lc(payer) && prior.opType === opType;
      return same
        ? r(200, { amount: amount.toString(), opId, opType, paymentNonce: nonce, success: true })
        : r(409, { error: "accessRecord.recordId is already paid with different signed payment fields", success: false });
    }

    let registrationPaid = true;
    let grantId: string | undefined;
    if (opType === "grant") {
      const g = this.grants.get(opId);
      if (!g) return r(404, { error: "Grant not found", success: false });
      if (g.revoked) return r(409, { error: "Grant has been revoked", success: false });
      registrationPaid = g.paymentStatus === "paid";
      grantId = g.id;
    }
    if (lc(asset) !== lc(this.config.asset)) return r(400, { error: "Payment asset does not match the canonical fee asset", success: false });

    const dp = this.dataPoints.get(lc(ar.dataPointId) as Hex);
    if (!dp) return r(400, { error: `accessRecord.dataPointId ${ar.dataPointId} not found in gateway`, success: false });
    if (!dp.versions.has(ar.version)) return r(400, { error: "accessRecord.version is not an available version of accessRecord.dataPointId", success: false });
    if (opType === "data_access") {
      const b = this.builders.get(lc(ar.accessor));
      const g = b && [...this.grants.values()].find((x) => lc(x.grantor) === lc(dp.owner) && x.grantee === b.id);
      if (!g || g.revoked || g.paymentStatus !== "paid" || !g.scopes.includes(dp.scope)) {
        return r(403, { error: "No active grant authorizes this accessor for the accessRecord data point scope", success: false });
      }
      grantId = g.id;
    }
    const server = await recoverTypedDataAddress({
      domain: this.domain(this.config.contracts.dataRegistry),
      message: { accessor: getAddress(ar.accessor), ownerAddress: getAddress(dp.owner), recordId: recordId as Hex, scope: dp.scope, version: BigInt(ar.version) },
      primaryType: "RecordDataAccess",
      signature: ar.signature as Hex,
      types: RECORD_DATA_ACCESS_TYPES,
    });
    const trusted = this.servers.get(lc(server));
    if (!trusted || lc(trusted.owner) !== lc(dp.owner)) {
      return r(401, { error: `accessRecord.signature signer ${server} is not a trusted server of ${dp.owner}`, success: false });
    }
    const fees = this.config.fees;
    const registrationDue = registrationPaid ? 0n : fees.grantRegistrationWei;
    const expected = registrationDue + fees.dataAccessWei;
    if (amount !== expected) {
      return r(400, {
        breakdown: { dataAccessFee: fees.dataAccessWei.toString(), registrationAlreadyPaid: registrationPaid, registrationFee: registrationDue.toString() },
        error: "Payment amount does not match the canonical fee total for this op",
        expectedTotal: expected.toString(),
        success: false,
      });
    }
    const balance = this.balances.get(lc(payer)) ?? 0n;
    const available = balance - this.authorized(payer);
    if (available < amount) {
      return r(402, { available: available.toString(), error: "Insufficient finalized balance for this payment", success: false });
    }
    const nonceKey = `${lc(payer)}:${nonce}`;
    if (this.nonces.has(nonceKey)) return r(409, { error: "paymentNonce already used by this payer", success: false });
    this.nonces.add(nonceKey);
    this.payments.set(recordId, {
      accessRecord: ar,
      amount,
      dataAccessFee: fees.dataAccessWei,
      grantId: grantId as string,
      nonce,
      opId,
      opType,
      payer,
      registrationFee: registrationDue,
      serverSignature: ar.signature,
      settled: false,
      signature: sig,
    });
    if (opType === "grant" && !registrationPaid) {
      const g = this.grants.get(opId);
      if (g) g.paymentStatus = "paid";
    }
    return r(200, {
      amount: amount.toString(),
      breakdown: { dataAccessFee: fees.dataAccessWei.toString(), registrationFee: registrationDue.toString(), registrationPaid: registrationDue > 0n },
      opId,
      opType,
      paidAt: new Date().toISOString(),
      payerAddress: payer,
      paymentNonce: nonce,
      success: true,
    });
  }

  /** The relayer's drain: confirm queued rows, then one recordAccessAndSettle tx per unsettled paid read. */
  settle(): Hex[] {
    for (const dp of this.dataPoints.values()) {
      for (const v of dp.versions.values()) v.status = "confirmed";
    }
    const hashes: Hex[] = [];
    for (const g of this.grants.values()) {
      if (g.paymentStatus === "paid" && g.status === "pending") {
        const hash = this.mine({ from: this.relayer, input: "0x", to: this.config.contracts.escrow, value: 0n });
        g.status = "confirmed";
        g.settleTxHash = hash;
        const reg = [...this.payments.values()].find((p) => p.opType === "grant" && p.opId === g.id && p.registrationFee > 0n);
        if (reg) this.emitSettled(hash, reg.payer, g.id, reg.registrationFee, OP_KIND.GrantRegistration);
      }
    }
    for (const [recordId, p] of this.payments) {
      if (p.settled) continue;
      const dp = this.dataPoints.get(lc(p.accessRecord.dataPointId) as Hex);
      if (!dp) continue;
      const ops = [{ amount: p.dataAccessFee, asset: this.config.asset as Hex, from: p.payer as Hex, opKind: OP_KIND.DataAccess, ref: p.grantId as Hex, to: PAYEE as Hex }];
      const input = encodeFunctionData({
        abi: RECORD_ACCESS_AND_SETTLE_ABI,
        args: [dp.owner as Hex, dp.scope, BigInt(p.accessRecord.version), p.accessRecord.accessor as Hex, recordId as Hex, p.serverSignature as Hex, ops],
        functionName: "recordAccessAndSettle",
      });
      const hash = this.mine({ from: this.relayer, input, to: this.config.contracts.escrow, value: 0n });
      this.emitSettled(hash, p.payer, p.grantId, p.dataAccessFee, OP_KIND.DataAccess);
      p.settled = true;
      this.balances.set(lc(p.payer), (this.balances.get(lc(p.payer)) ?? 0n) - p.amount);
      hashes.push(hash);
    }
    return hashes;
  }

  private mine(tx: Omit<ChainTx, "hash">, raw?: Hex): Hex {
    this.blockNumber += 1n;
    const hash = raw ? keccak256(raw) : keccak256(toHex(`fake-tx-${this.blockNumber}-${this.txs.size}`));
    this.txs.set(lc(hash), { ...tx, hash });
    return hash;
  }

  private emitSettled(txHash: Hex, from: string, ref: string, amount: bigint, opKind: number): void {
    const topics = encodeEventTopics({ abi: SETTLED_EVENT_ABI, args: { from: from as Hex, ref: ref as Hex, to: PAYEE as Hex }, eventName: "Settled" }) as Hex[];
    const data = encodeAbiParameters([{ type: "address" }, { type: "uint256" }, { type: "uint8" }], [this.config.asset as Hex, amount, opKind]);
    this.logs.push({ address: this.config.contracts.escrow, blockNumber: this.blockNumber, data, topics, transactionHash: txHash });
  }

  private async handleRpc(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const { id, method, params } = JSON.parse(await readBody(req)) as { id: number; method: string; params: unknown[] };
    this.rpcCalls.push(method);
    const ok = (result: unknown) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ id, jsonrpc: "2.0", result }));
    };
    const hex = (n: bigint) => `0x${n.toString(16)}`;
    switch (method) {
      case "eth_chainId":
        return ok(hex(this.config.chainId));
      case "eth_blockNumber":
        return ok(hex(this.blockNumber));
      case "eth_gasPrice":
        return ok(hex(GAS_PRICE));
      case "eth_estimateGas":
        return ok(hex(GAS));
      case "eth_getBalance":
        return ok(hex(this.native.get(lc(String(params[0]))) ?? 0n));
      case "eth_getTransactionCount": {
        const from = lc(String(params[0]));
        return ok(hex(BigInt([...this.txs.values()].filter((t) => lc(t.from) === from).length)));
      }
      case "eth_sendRawTransaction": {
        const raw = params[0] as Hex;
        const tx = parseTransaction(raw);
        const from = await recoverTransactionAddress({ serializedTransaction: raw as never });
        if (BigInt(tx.chainId ?? 0) !== this.config.chainId) throw new Error("wrong chain id");
        if (lc(tx.to ?? "") !== lc(this.config.contracts.escrow)) throw new Error("not the escrow");
        const call = decodeFunctionData({ abi: ESCROW_DEPOSIT_ABI, data: tx.data as Hex });
        if (call.functionName !== "depositNative") throw new Error("not depositNative");
        const expectedNonce = [...this.txs.values()].filter((t) => lc(t.from) === lc(from)).length;
        if (tx.nonce !== expectedNonce) throw new Error(`nonce ${tx.nonce} != ${expectedNonce}`);
        const value = tx.value ?? 0n;
        const cost = value + (tx.gas ?? 0n) * (tx.gasPrice ?? 0n);
        const bal = this.native.get(lc(from)) ?? 0n;
        if (bal < cost) throw new Error("insufficient funds for gas * price + value");
        this.native.set(lc(from), bal - cost);
        return ok(this.mine({ from, input: tx.data as Hex, to: tx.to as string, value }, raw));
      }
      case "eth_getTransactionByHash": {
        const t = this.txs.get(lc(String(params[0])));
        return ok(t ? { from: t.from, hash: t.hash, input: t.input, to: t.to, value: hex(t.value) } : null);
      }
      case "eth_getLogs": {
        const f = params[0] as { address: string; fromBlock: Hex; toBlock: Hex; topics: (Hex | null)[] };
        const out = this.logs.filter(
          (l) =>
            lc(l.address) === lc(f.address) &&
            l.blockNumber >= BigInt(f.fromBlock) &&
            l.blockNumber <= BigInt(f.toBlock) &&
            f.topics.every((t, i) => t === null || lc(t) === lc(l.topics[i] ?? ""))
        );
        return ok(out.map((l) => ({ ...l, blockNumber: hex(l.blockNumber) })));
      }
      default:
        throw new Error(`unsupported ${method}`);
    }
  }
}
