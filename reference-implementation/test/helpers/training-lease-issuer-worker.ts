// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Worker thread for the L3 issuance-versus-withdrawal race. It opens its own
 * connection to the shared authority store, as a separate AS node would, and
 * issues leases in a tight loop until the store refuses. Each worker's clock
 * advances one second per attempt, so every committed lease has a later `exp`.
 */
import { parentPort, workerData } from "node:worker_threads";
import { TrainingAuthorityStore } from "../../lib/training-lease/authority-store.ts";

interface Input {
  storePath: string;
  journalPath: string;
  grantId: string;
  clientId: string;
  nodeId: string;
  baseMs: number;
  maxAttempts: number;
  counter: Int32Array;
}

const input = workerData as Input;
let tick = 0;
const store = TrainingAuthorityStore.open({
  storePath: input.storePath,
  journalPath: input.journalPath,
  issuer: "https://as.example",
  nodeId: input.nodeId,
  now: () => input.baseMs + tick * 1000,
});
const issued: Array<{ jti: string; exp: number }> = [];
let refusal: string | null = null;
for (let i = 0; i < input.maxAttempts; i += 1) {
  tick += 1;
  const out = store.issueLease({
    grantId: input.grantId,
    clientId: input.clientId,
  });
  if (out.ok) {
    issued.push({ jti: out.claims.jti, exp: out.claims.exp });
    Atomics.add(input.counter, 0, 1);
  } else {
    refusal = out.reason;
    break;
  }
}
store.close();
parentPort?.postMessage({ issued, refusal });
