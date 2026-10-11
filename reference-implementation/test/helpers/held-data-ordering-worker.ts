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

const { journalPath, epochMarkerPath, gate, scenario, paused } = workerData;
const barrier = new Int32Array(gate);
let armed = false;
const now = () => {
  if (armed && paused) {
    armed = false;
    port.postMessage({ type: "checkpoint" });
    Atomics.wait(barrier, 0, 0);
  }
  return 1000;
};
// Detect contention rather than waiting a guessed number of milliseconds.
// This only observes the lock; all reads and writes still use the real FS.
const mkdir = fs.mkdirSync;
let notified = false;
fs.mkdirSync = ((...args: Parameters<typeof mkdir>) => {
  try {
    return mkdir(...args);
  } catch (error) {
    if (!notified && String(args[0]) === `${journalPath}.lock` && (error as NodeJS.ErrnoException).code === "EEXIST") {
      notified = true;
      port.postMessage({ type: "contended" });
    }
    throw error;
  }
}) as typeof mkdir;
syncBuiltinESMExports();
let authority = scenario === "startup" ? null : HeldDataAuthority.open({ epochMarkerPath, journalPath, now });
port.postMessage({ type: "ready" });
port.on("message", () => {
  armed = true;
  let result: unknown;
  if (scenario === "startup") {
    authority = HeldDataAuthority.open({ epochMarkerPath, journalPath, now });
    result = { lost: authority.lost };
  } else if (scenario === "status" && paused) {
    if (!authority) {
      throw new Error("missing authority");
    }
    const principal = authority.authenticateRead({ token: "test-token" });
    if (!principal) {
      throw new Error("missing test principal");
    }
    [result] = authority.status(principal, ["g"]);
  } else {
    if (!authority) {
      throw new Error("missing authority");
    }
    result = authority.requestErasure({ grantId: "g", origin: "concurrent-retry" });
  }
  port.postMessage({ result, type: "done" });
  port.close();
});
