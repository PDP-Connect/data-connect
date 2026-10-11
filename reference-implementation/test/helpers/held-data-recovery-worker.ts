// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { parentPort, workerData } from "node:worker_threads";
import { HeldDataAuthority } from "../../lib/held-data/authority.ts";

if (!parentPort) {
  throw new Error("worker port required");
}
const port = parentPort;
const { opts, gate, recovering } = workerData;
const barrier = new Int32Array(gate);
let armed = false;
let notified = false;
const readFile = fs.readFileSync;
fs.readFileSync = ((...args: Parameters<typeof readFile>) => {
  const result = readFile(...args);
  if (armed && recovering && String(args[0]) === opts.journalPath) {
    armed = false;
    // Pause after recovery reconstructed its projection, before replay writes.
    port.postMessage({ type: "checkpoint" });
    Atomics.wait(barrier, 0, 0);
  }
  return result;
}) as typeof readFile;
const mkdir = fs.mkdirSync;
fs.mkdirSync = ((...args: Parameters<typeof mkdir>) => {
  try {
    return mkdir(...args);
  } catch (error) {
    if (
      !notified &&
      String(args[0]) === `${opts.journalPath}.lock` &&
      (error as NodeJS.ErrnoException).code === "EEXIST"
    ) {
      notified = true;
      port.postMessage({ type: "contended" });
    }
    throw error;
  }
}) as typeof mkdir;
syncBuiltinESMExports();
const authority = HeldDataAuthority.open({ ...opts, now: () => 1000 });
port.postMessage({ type: "ready" });
port.on("message", () => {
  armed = true;
  if (recovering) {
    authority.reestablishHistory();
  } else {
    authority.requestErasure({ grantId: "g", origin: "concurrent-retry" });
  }
  port.postMessage({ type: "done" });
  port.close();
});
