// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Wires config, keys, state and clients from env, for the moksha CLI and the
// reminder service's `--payer moksha`.

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { FetchLike } from "../../reminder-service/lib/oauth.ts";
import { loadConfig, type MokshaConfig } from "./config.ts";
import { GatewayClient } from "./gateway.ts";
import { loadKeys, type MokshaKeys } from "./keys.ts";
import { MokshaPayer } from "./payer.ts";
import { Registrar } from "./register.ts";
import { JsonRpc } from "./rpc.ts";
import { MokshaState } from "./state.ts";

export const DEFAULT_STATE_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", ".state");

export interface MokshaContext {
  config: MokshaConfig;
  gateway: GatewayClient;
  keys: MokshaKeys;
  log: (line: Record<string, unknown>) => void;
  payer: MokshaPayer;
  registrar: Registrar;
  rpc: JsonRpc;
  state: MokshaState;
}

export function buildContext(opts: {
  config?: MokshaConfig;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: FetchLike;
  keys?: MokshaKeys;
  log?: (line: Record<string, unknown>) => void;
  now?: () => Date;
}): MokshaContext {
  const env = opts.env ?? process.env;
  const config = opts.config ?? loadConfig(env, { stateDir: DEFAULT_STATE_DIR });
  const keys = opts.keys ?? loadKeys(env);
  const state = new MokshaState(config.stateDir, { now: opts.now });
  const log = opts.log ?? ((line) => console.log(JSON.stringify(line)));
  const gateway = new GatewayClient(config, opts.fetchImpl);
  const registrar = new Registrar({ config, gateway, keys, log, state });
  const payer = new MokshaPayer({ config, fetchImpl: opts.fetchImpl, keys, registrar, state });
  return { config, gateway, keys, log, payer, registrar, rpc: new JsonRpc(config.rpcUrl, opts.fetchImpl), state };
}
