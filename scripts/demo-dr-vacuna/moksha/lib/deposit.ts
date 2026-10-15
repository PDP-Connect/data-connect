// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Escrow deposit for the builder, and its balance.
//
// The fee asset is native VANA, so the gasless path does not apply: data-
// gateway's POST /v1/escrow/deposit-with-authorization is EIP-3009 (ERC-20
// receiveWithAuthorization) only. The builder therefore sends
// DataPortabilityEscrow.depositNative(builder) itself, paying the value and
// the gas, then reports the tx hash to POST /v1/escrow/deposit. The gateway
// credits the balance once the tx's block is finalized.

import { encodeFunctionData, formatEther, type Hex, keccak256, parseAbi } from "viem";
import type { MokshaConfig } from "./config.ts";
import type { GatewayClient } from "./gateway.ts";
import type { MokshaKeys } from "./keys.ts";
import type { JsonRpc } from "./rpc.ts";
import type { DepositState, MokshaState } from "./state.ts";

export const ESCROW_DEPOSIT_ABI = parseAbi(["function depositNative(address account) payable"]);

export interface DepositDeps {
  config: MokshaConfig;
  gateway: GatewayClient;
  keys: MokshaKeys;
  log?: (line: Record<string, unknown>) => void;
  rpc: JsonRpc;
  sleep?: (ms: number) => Promise<void>;
  state: MokshaState;
}

const hex = (n: bigint): Hex => `0x${n.toString(16)}`;

/**
 * Sends one depositNative tx unless an earlier one was never reported to the
 * gateway (then only that one is reported again). A second deposit needs
 * `again: true`, so a rerun cannot double-fund by accident.
 */
export async function depositNative(deps: DepositDeps, opts: { again?: boolean; amountWei: bigint }): Promise<DepositState> {
  const { config, keys, rpc, state } = deps;
  const log = deps.log ?? (() => {});
  const unreported = state.data.deposits.find((d) => !d.submittedToGateway);
  if (unreported) {
    log({ event: "deposit_resubmit", txHash: unreported.txHash });
    return submitDeposit(deps, unreported);
  }
  if (state.data.deposits.length > 0 && !opts.again) {
    throw new Error("a deposit already exists in state; pass --again to send another");
  }
  if (opts.amountWei <= 0n || opts.amountWei > config.maxDepositWei) {
    throw new Error(`deposit must be > 0 and <= ${formatEther(config.maxDepositWei)} VANA (VACUNA_MOKSHA_MAX_DEPOSIT_WEI)`);
  }
  const builder = keys.builder;
  const chainId = BigInt(await rpc.call<string>("eth_chainId"));
  if (chainId !== config.chainId) {
    throw new Error(`RPC chain id ${chainId} != expected ${config.chainId}`);
  }
  const data = encodeFunctionData({ abi: ESCROW_DEPOSIT_ABI, args: [builder.address], functionName: "depositNative" });
  const to = config.contracts.escrow as Hex;
  const [nonceHex, gasPriceHex, gasHex, balanceHex] = await Promise.all([
    rpc.call<string>("eth_getTransactionCount", [builder.address, "pending"]),
    rpc.call<string>("eth_gasPrice"),
    rpc.call<string>("eth_estimateGas", [{ data, from: builder.address, to, value: hex(opts.amountWei) }]),
    rpc.call<string>("eth_getBalance", [builder.address, "latest"]),
  ]);
  const gas = (BigInt(gasHex) * 12n) / 10n;
  const gasPrice = BigInt(gasPriceHex);
  const needed = opts.amountWei + gas * gasPrice;
  if (BigInt(balanceHex) < needed) {
    throw new Error(`builder ${builder.address} holds ${formatEther(BigInt(balanceHex))} VANA, needs ${formatEther(needed)} (deposit + gas)`);
  }
  const serialized = await builder.signTransaction({
    chainId: Number(chainId),
    data,
    gas,
    gasPrice,
    nonce: Number(BigInt(nonceHex)),
    to,
    type: "legacy",
    value: opts.amountWei,
  });
  const txHash = keccak256(serialized);
  const record: DepositState = {
    account: builder.address,
    amountWei: opts.amountWei.toString(),
    chainNonce: BigInt(nonceHex).toString(),
    createdAt: state.nowIso(),
    gatewayStatus: null,
    submittedToGateway: false,
    txHash,
  };
  // Persist before broadcasting: a crash after the send leaves a hash to report, not a lost deposit.
  state.data.deposits.push(record);
  state.save();
  const sent = await rpc.call<string>("eth_sendRawTransaction", [serialized]);
  if (sent.toLowerCase() !== txHash.toLowerCase()) {
    throw new Error(`RPC returned tx hash ${sent}, expected ${txHash}`);
  }
  log({ amountVana: formatEther(opts.amountWei), event: "deposit_broadcast", txHash });
  return submitDeposit(deps, record);
}

/** POST /v1/escrow/deposit, retrying while the RPC behind the gateway has not seen the tx. */
export async function submitDeposit(deps: DepositDeps, record: DepositState, attempts = 10): Promise<DepositState> {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  for (let i = 0; i < attempts; i++) {
    const res = await deps.gateway.submitDeposit(record.txHash);
    if (res.status === 200 || res.status === 202) {
      record.submittedToGateway = true;
      record.gatewayStatus = res.body.status ?? null;
      deps.state.save();
      deps.log?.({ event: "deposit_reported", status: record.gatewayStatus, txHash: record.txHash });
      return record;
    }
    if (res.status !== 404 && res.status < 500) {
      throw new Error(`POST /v1/escrow/deposit: HTTP ${res.status} ${JSON.stringify(res.body)}`);
    }
    await sleep(6_000);
  }
  throw new Error(`POST /v1/escrow/deposit: gateway still cannot see ${record.txHash}; rerun \`deposit\` to report it again`);
}

/** Gateway escrow balance (finalized / pending / authorized) plus the builder's native gas balance. */
export async function readBalance(deps: Pick<DepositDeps, "config" | "gateway" | "keys" | "rpc">) {
  const account = deps.keys.builder.address;
  // The gateway credits a submitted deposit only on this sync; a plain GET
  // leaves it pending forever. Fall back to the GET where sync is absent.
  const syncOrGet = async () => {
    const synced = await deps.gateway.syncBalance(account);
    return synced.status === 404 || synced.status === 405 ? await deps.gateway.getBalance(account) : synced;
  };
  const [escrow, nativeHex] = await Promise.all([
    syncOrGet(),
    deps.rpc.call<string>("eth_getBalance", [account, "latest"]).catch(() => null),
  ]);
  if (escrow.status !== 200) {
    throw new Error(`GET /v1/escrow/balance: HTTP ${escrow.status} ${JSON.stringify(escrow.body)}`);
  }
  const native = nativeHex === null ? null : BigInt(nativeHex);
  return {
    account,
    escrow: escrow.body,
    nativeGasBalanceVana: native === null ? null : formatEther(native),
    paidReadsAffordable: (escrow.body.balances ?? [])
      .filter((b) => b.asset.toLowerCase() === deps.config.asset.toLowerCase())
      .map((b) => (BigInt(b.availableAmount) / deps.config.fees.dataAccessWei).toString())[0] ?? "0",
  };
}
