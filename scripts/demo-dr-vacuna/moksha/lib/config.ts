// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Moksha (Vana testnet) settings for the "Vacuna al día" paid reads, and the
// network gate. Every URL this module talks to passes `assertAllowedRemote`:
// loopback is always allowed, anything else must be https and its origin
// listed in an allowlist env var. Nothing defaults to a remote host.

import { getAddress } from "viem";
import { assertAllowedRemote, NATIVE_ASSET } from "../../reminder-service/lib/payer.ts";

/**
 * Public Moksha values. Contract addresses other than the escrow come from
 * data-gateway `.env.example` (the template the dp-rpc.moksha deployment is
 * described with); the escrow was given by the pilot brief. None of them was
 * read from the live gateway. A wrong verifying contract shows up as a 401
 * on the first signed POST, which has no side effect.
 */
export const MOKSHA = {
  chainId: 14800n,
  contracts: {
    /** EIP-712 domain for AddData and RecordDataAccess (DataRegistryV2). */
    dataRegistry: "0x8f1eFCdff3d0d5BB535e32620721c7EBed151867",
    /** GenericPayment domain; depositNative target; recordAccessAndSettle. */
    escrow: "0x07d7769081adc3a3DBe91f5E4B98E9A5a6B292e3",
    feeRegistry: "0xb4FA18443E0FA6cdC0280D20b8cCDB2377D13Bf2",
    /** BuilderRegistration domain (DataPortabilityGrantees). */
    grantees: "0x8325C0A0948483EdA023A1A2Fd895e62C5131234",
    /** GrantRegistration domain (DataPortabilityPermissions). */
    permissions: "0x4d3FA76064D88e0454cFc4CaD7e5FeC3e3124011",
    /** ServerRegistration domain (DataPortabilityServer). */
    servers: "0xCae2CE0e9caa6643ed28186cF57bd40Bd9E17Eab",
  },
  /** Unverified: not in data-gateway docs. */
  explorerUrl: "https://moksha.vanascan.io",
  gatewayUrl: "https://dp-rpc.moksha.vana.org",
  /** Unverified: data-gateway only names the mainnet RPC (rpc.vana.org). */
  rpcUrl: "https://rpc.moksha.vana.org",
} as const;

/** FeeRegistry values in the pilot brief; the gateway re-reads them on every pay. */
export const FEES = {
  dataAccessWei: 10n ** 16n, // 0.01 VANA
  grantRegistrationWei: 10n ** 15n, // 0.001 VANA
} as const;

export const DEFAULT_SCOPE = "dr.vacuna.child_immunizations";
export const DEFAULT_SERVER_URL = "https://registro.vacuna.example/pdpp";

export interface MokshaConfig {
  asset: string;
  chainId: bigint;
  contracts: { dataRegistry: string; escrow: string; grantees: string; permissions: string; servers: string };
  explorerUrl: string;
  fees: { dataAccessWei: bigint; grantRegistrationWei: bigint };
  gatewayUrl: string;
  /** Hard cap on paid reads this state dir will ever sign. */
  maxPaidReads: number;
  /** Hard cap on children `register` will set up. */
  maxChildren: number;
  /** Hard cap on one deposit, in wei. */
  maxDepositWei: bigint;
  rpcUrl: string;
  scope: string;
  /** `serverUrl` in each child's ServerRegistration (part of the serverId). */
  serverUrl: string;
  stateDir: string;
}

function addr(value: string): string {
  return getAddress(value);
}

function positiveInt(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined || value === "") {
    return fallback;
  }
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }
  return n;
}

/**
 * Reads VACUNA_* env. Defaults: loopback gateway and RPC, Moksha chain id and
 * contracts, caps of 10 paid reads, 2 children and a 2 VANA deposit.
 */
export function loadConfig(env: NodeJS.ProcessEnv, defaults: { stateDir: string }): MokshaConfig {
  const gatewayUrl = assertAllowedRemote(
    env.VACUNA_GATEWAY_URL || "http://127.0.0.1:8787",
    env.VACUNA_GATEWAY_ALLOWLIST,
    "VACUNA_GATEWAY_ALLOWLIST"
  );
  const rpcUrl = assertAllowedRemote(env.VACUNA_RPC_URL || "http://127.0.0.1:8545", env.VACUNA_RPC_ALLOWLIST, "VACUNA_RPC_ALLOWLIST");
  return {
    asset: addr(env.VACUNA_PAYMENT_ASSET || NATIVE_ASSET),
    chainId: BigInt(env.VACUNA_CHAIN_ID || MOKSHA.chainId),
    contracts: {
      dataRegistry: addr(env.VACUNA_DATA_REGISTRY_CONTRACT || MOKSHA.contracts.dataRegistry),
      escrow: addr(env.VACUNA_ESCROW_CONTRACT || MOKSHA.contracts.escrow),
      grantees: addr(env.VACUNA_GRANTEES_CONTRACT || MOKSHA.contracts.grantees),
      permissions: addr(env.VACUNA_PERMISSIONS_CONTRACT || MOKSHA.contracts.permissions),
      servers: addr(env.VACUNA_SERVERS_CONTRACT || MOKSHA.contracts.servers),
    },
    explorerUrl: (env.VACUNA_EXPLORER_URL || MOKSHA.explorerUrl).replace(/\/+$/, ""),
    fees: {
      dataAccessWei: BigInt(env.VACUNA_DATA_ACCESS_FEE_WEI || FEES.dataAccessWei),
      grantRegistrationWei: BigInt(env.VACUNA_GRANT_REGISTRATION_FEE_WEI || FEES.grantRegistrationWei),
    },
    gatewayUrl: gatewayUrl.replace(/\/+$/, ""),
    maxChildren: positiveInt(env.VACUNA_MOKSHA_MAX_CHILDREN, 2, "VACUNA_MOKSHA_MAX_CHILDREN"),
    maxDepositWei: BigInt(env.VACUNA_MOKSHA_MAX_DEPOSIT_WEI || 2n * 10n ** 18n),
    maxPaidReads: positiveInt(env.VACUNA_MOKSHA_MAX_PAID_READS, 10, "VACUNA_MOKSHA_MAX_PAID_READS"),
    rpcUrl,
    scope: env.VACUNA_DATA_POINT_SCOPE || DEFAULT_SCOPE,
    serverUrl: env.VACUNA_REGISTER_SERVER_URL || DEFAULT_SERVER_URL,
    stateDir: env.VACUNA_MOKSHA_STATE_DIR || defaults.stateDir,
  };
}

export function explorerTxUrl(config: Pick<MokshaConfig, "explorerUrl">, txHash: string): string {
  return `${config.explorerUrl}/tx/${txHash}`;
}

export function explorerAddressUrl(config: Pick<MokshaConfig, "explorerUrl">, address: string): string {
  return `${config.explorerUrl}/address/${address}`;
}
