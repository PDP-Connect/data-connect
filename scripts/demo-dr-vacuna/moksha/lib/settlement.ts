// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Settlement poller: records each paid read's settlement status and tx hash
// for a dashboard (`<state dir>/settlements.json`).
//
// The gateway API has no per-payment read endpoint (payments settle through
// operator-only /v1/escrow/settle and the cron drain). What it does expose:
//   GET /v1/escrow/balance?account=   finalized balance and authorizedAmount
//                                     (paid, not yet debited on chain)
//   GET /v1/grants?user=&builder=     grant chain status, paymentStatus,
//                                     settleTxHash
// The per-read tx comes from the chain: the gateway relayer settles each
// paid read with one Escrow.recordAccessAndSettle(owner, scope, version,
// accessor, recordId, serverSignature, ops) tx, which emits
// Settled(from = builder, to = payee, ref = grantId, asset, amount,
// opKind = 5 DataAccess). The poller filters those logs by `from`, reads
// each tx and decodes recordId from its calldata, which is the read id the
// payment was signed for. Read-only RPC; no keys used.

import { decodeEventLog, decodeFunctionData, formatEther, type Hex, pad, parseAbi, toEventSelector } from "viem";
import { explorerAddressUrl, explorerTxUrl, type MokshaConfig } from "./config.ts";
import type { GatewayClient } from "./gateway.ts";
import type { MokshaKeys } from "./keys.ts";
import type { Registrar } from "./register.ts";
import type { JsonRpc } from "./rpc.ts";
import type { MokshaState } from "./state.ts";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

export const SETTLED_EVENT_ABI = parseAbi([
  "event Settled(address indexed from, address indexed to, bytes32 indexed ref, address asset, uint256 amount, uint8 opKind)",
]);
export const RECORD_ACCESS_AND_SETTLE_ABI = parseAbi([
  "struct SettleOp { address from; address to; address asset; uint256 amount; uint8 opKind; bytes32 ref; }",
  "function recordAccessAndSettle(address ownerAddress, string scope, uint256 version, address accessor, bytes32 recordId, bytes serverSignature, SettleOp[] ops) external",
]);
export const OP_KIND = { DataAccess: 5, GrantRegistration: 4 } as const;
const SETTLED_TOPIC = toEventSelector(SETTLED_EVENT_ABI[0]);

interface RpcLog {
  blockNumber: Hex;
  data: Hex;
  topics: Hex[];
  transactionHash: Hex;
}

export interface PollDeps {
  config: MokshaConfig;
  gateway: GatewayClient;
  keys: MokshaKeys;
  log?: (line: Record<string, unknown>) => void;
  registrar: Registrar;
  rpc: JsonRpc;
  state: MokshaState;
}

/** First block to scan on a fresh state dir: VACUNA_MOKSHA_FROM_BLOCK, else latest - lookback. */
export async function pollSettlements(deps: PollDeps, opts: { fromBlock?: bigint; lookback?: bigint; maxRange?: bigint } = {}) {
  const { config, gateway, keys, rpc, state } = deps;
  const log = deps.log ?? (() => {});
  const builder = keys.builder.address;

  const balance = await gateway.getBalance(builder);
  state.data.poll.balance = balance.status === 200 ? balance.body : { error: balance.body, status: balance.status };

  for (const childId of Object.keys(state.data.children)) {
    await deps.registrar.refreshGrant(childId);
  }

  const latest = BigInt(await rpc.call<string>("eth_blockNumber"));
  let from =
    state.data.poll.fromBlock !== null
      ? BigInt(state.data.poll.fromBlock)
      : (opts.fromBlock ?? (latest > (opts.lookback ?? 20_000n) ? latest - (opts.lookback ?? 20_000n) : 0n));
  const maxRange = opts.maxRange ?? 5_000n;
  const byReadId = state.data.payments;
  const grantToChild = new Map(
    Object.values(state.data.children)
      .filter((c) => c.grantId)
      .map((c) => [String(c.grantId).toLowerCase(), c.childId])
  );
  let matched = 0;
  while (from <= latest) {
    const to = from + maxRange - 1n < latest ? from + maxRange - 1n : latest;
    const logs = await rpc.call<RpcLog[]>("eth_getLogs", [
      {
        address: config.contracts.escrow,
        fromBlock: `0x${from.toString(16)}`,
        toBlock: `0x${to.toString(16)}`,
        topics: [SETTLED_TOPIC, pad(builder.toLowerCase() as Hex, { size: 32 })],
      },
    ]);
    for (const l of logs) {
      const ev = decodeEventLog({ abi: SETTLED_EVENT_ABI, data: l.data, topics: l.topics as [Hex, ...Hex[]] });
      const { opKind, ref } = ev.args;
      if (opKind === OP_KIND.DataAccess) {
        const tx = await rpc.call<{ input: Hex } | null>("eth_getTransactionByHash", [l.transactionHash]);
        let recordId: string | null = null;
        try {
          const call = decodeFunctionData({ abi: RECORD_ACCESS_AND_SETTLE_ABI, data: (tx?.input ?? "0x") as Hex });
          recordId = String(call.args[4]).toLowerCase();
        } catch {
          // not a recordAccessAndSettle call; kept as unmatched below
        }
        const p = recordId ? byReadId[recordId] : undefined;
        if (p) {
          p.status = "settled";
          p.settleTxHash = l.transactionHash;
          p.settleBlock = BigInt(l.blockNumber).toString();
          p.settledAt ??= state.nowIso();
          p.explorerUrl = explorerTxUrl(config, l.transactionHash);
          matched += 1;
          continue;
        }
      }
      const known = state.data.poll.unmatchedSettlements.some((u) => u.txHash === l.transactionHash && u.ref === ref);
      if (!known) {
        state.data.poll.unmatchedSettlements.push({ opKind, ref, txHash: l.transactionHash });
      }
      if (opKind === OP_KIND.GrantRegistration && grantToChild.has(ref.toLowerCase())) {
        log({ child: grantToChild.get(ref.toLowerCase()), event: "grant_fee_settled", txHash: l.transactionHash });
      }
    }
    from = to + 1n;
  }
  state.data.poll.fromBlock = from.toString();
  state.data.poll.lastPolledAt = state.nowIso();
  state.save();
  const dashboard = writeDashboard(config, state);
  log({ event: "poll_done", latestBlock: latest.toString(), matched, ...dashboard.totals });
  return dashboard;
}

export function writeDashboard(config: MokshaConfig, state: MokshaState) {
  const rows = state.dashboardRows().map((p) => ({
    acceptedAt: p.acceptedAt,
    amountVana: formatEther(BigInt(p.amountWei)),
    childId: p.childId,
    explorerUrl: p.explorerUrl,
    opType: p.opType,
    readId: p.readId,
    settledAt: p.settledAt,
    settleTxHash: p.settleTxHash,
    status: p.status,
  }));
  const totals: Record<string, number> = {};
  for (const r of rows) {
    totals[r.status] = (totals[r.status] ?? 0) + 1;
  }
  const children = Object.values(state.data.children).map((c) => ({
    childId: c.childId,
    dataPointId: c.dataPointId,
    grantId: c.grantId,
    grantPaid: c.grantPaid,
    grantStatus: c.grantChain?.status ?? null,
    grantTxUrl: c.grantChain?.settleTxHash ? explorerTxUrl(config, c.grantChain.settleTxHash) : null,
    ownerUrl: explorerAddressUrl(config, c.ownerAddress),
  }));
  const dashboard = {
    builder: state.data.builder?.address ?? null,
    builderUrl: state.data.builder ? explorerAddressUrl(config, state.data.builder.address) : null,
    children,
    escrow: state.data.poll.balance,
    escrowUrl: explorerAddressUrl(config, config.contracts.escrow),
    generatedAt: state.nowIso(),
    payments: rows,
    totals,
  };
  writeFileSync(join(config.stateDir, "settlements.json"), `${JSON.stringify(dashboard, null, 2)}\n`);
  return dashboard;
}
