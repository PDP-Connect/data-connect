// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Key material for the Moksha run. Keys are read from files named by env vars
// and never logged, persisted to state or put in an error message (errors
// name the env var and file path only).
//
//   VACUNA_BUILDER_KEY_FILE      reminder service (builder / payer / grantee)
//   VACUNA_REGISTER_KEY_FILE     the register's root key; each child's server
//                                key is derived from it (see below)
//   VACUNA_CHILD_KEY_SEED_FILE   seed for synthetic per-child owner keys
//
// Why one server key per child: data-gateway binds a server address to ONE
// owner (`servers.server_address` is unique, lib/servers.ts), and
// RecordDataAccess must be signed by a trusted server of the data point's
// owner. With one synthetic owner per child, the register therefore acts as
// each child's server under a per-child key it alone can derive.

import { chmodSync, existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { concat, type Hex, keccak256, toHex } from "viem";
import { generatePrivateKey, type LocalAccount, privateKeyToAccount } from "viem/accounts";

const KEY_RE = /^0x[0-9a-fA-F]{64}$/;
// secp256k1 group order; a derived scalar must be in [1, n-1].
const SECP256K1_N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;

export const KEY_ENV = {
  builder: "VACUNA_BUILDER_KEY_FILE",
  childSeed: "VACUNA_CHILD_KEY_SEED_FILE",
  register: "VACUNA_REGISTER_KEY_FILE",
} as const;

function readSecretFile(path: string, envName: string): string {
  let mode: number;
  try {
    mode = statSync(path).mode;
  } catch {
    throw new Error(`${envName}: cannot read ${path}`);
  }
  if (process.platform !== "win32" && (mode & 0o077) !== 0) {
    throw new Error(`${envName}: ${path} is readable by group/others; chmod 600 it`);
  }
  return readFileSync(path, "utf8").trim();
}

function loadKey(path: string, envName: string): Hex {
  const value = readSecretFile(path, envName);
  if (!KEY_RE.test(value)) {
    throw new Error(`${envName}: ${path} must hold one 0x-prefixed 32-byte hex private key`);
  }
  return value as Hex;
}

function derive(root: Hex, label: string): Hex {
  for (let counter = 0; ; counter++) {
    const k = keccak256(concat([root, toHex(`${label}#${counter}`)]));
    const n = BigInt(k);
    if (n > 0n && n < SECP256K1_N) {
      return k;
    }
  }
}

export interface MokshaKeys {
  builder: LocalAccount;
  /** Synthetic owner of the child's data point and grantor of its grant. */
  childOwner: (childId: string) => LocalAccount;
  /** The register's server key for this child (signs AddData and RecordDataAccess). */
  childServer: (childId: string) => LocalAccount;
}

export function keysFromSecrets(secrets: { builder: Hex; childSeed: Hex; register: Hex }): MokshaKeys {
  const owners = new Map<string, LocalAccount>();
  const servers = new Map<string, LocalAccount>();
  return {
    builder: privateKeyToAccount(secrets.builder),
    childOwner: (childId) => {
      let a = owners.get(childId);
      if (!a) {
        a = privateKeyToAccount(derive(secrets.childSeed, `vacuna/moksha/child-owner/v1/${childId}`));
        owners.set(childId, a);
      }
      return a;
    },
    childServer: (childId) => {
      let a = servers.get(childId);
      if (!a) {
        a = privateKeyToAccount(derive(secrets.register, `vacuna/moksha/register-server/v1/${childId}`));
        servers.set(childId, a);
      }
      return a;
    },
  };
}

export function loadKeys(env: NodeJS.ProcessEnv): MokshaKeys {
  const path = (name: string): string => {
    const v = env[name];
    if (!v) {
      throw new Error(`${name} is not set (path to a 0600 file holding a 0x-prefixed 32-byte hex key)`);
    }
    return v;
  };
  return keysFromSecrets({
    builder: loadKey(path(KEY_ENV.builder), KEY_ENV.builder),
    childSeed: loadKey(path(KEY_ENV.childSeed), KEY_ENV.childSeed),
    register: loadKey(path(KEY_ENV.register), KEY_ENV.register),
  });
}

/** Writes three fresh 0600 key files; refuses to overwrite. Returns the paths. */
export function initKeyFiles(dir: string): { builder: string; childSeed: string; register: string } {
  const paths = { builder: `${dir}/builder.key`, childSeed: `${dir}/child-seed.key`, register: `${dir}/register.key` };
  for (const p of Object.values(paths)) {
    if (existsSync(p)) {
      throw new Error(`refusing to overwrite ${p}`);
    }
  }
  for (const p of Object.values(paths)) {
    writeFileSync(p, `${generatePrivateKey()}\n`, { flag: "wx", mode: 0o600 });
    chmodSync(p, 0o600);
  }
  return paths;
}
