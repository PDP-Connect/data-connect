// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { parentPort, workerData } from "node:worker_threads";
import { appendJournalEntry } from "../../lib/authority-journal/journal.ts";
import { HeldDataAuthority } from "../../lib/held-data/authority.ts";

if (!parentPort) {
  throw new Error("worker port required");
}
const port = parentPort;

const { journalPath, epochMarkerPath, worker, gate, count } = workerData;
const barrier = new Int32Array(gate);
port.postMessage("ready");
Atomics.wait(barrier, 0, 0);
const authority = HeldDataAuthority.open({ epochMarkerPath, journalPath, now: () => 1000 });
for (let i = 0; i < count; i += 1) {
  appendJournalEntry(journalPath, {
    grant_id: "g",
    id: `${worker}-${i}`,
    t: i % 2 ? "hd_keep" : "probe",
  });
}
authority.requestErasure({ grantId: "g", origin: `worker-${worker}` });
port.postMessage("acknowledged");
port.on("message", () => {
  const principal = authority.authenticateRead({ token: "test-token" });
  if (!principal) {
    throw new Error("missing test principal");
  }
  const [answer] = authority.status(principal, ["g"]);
  port.postMessage({ answer, lost: authority.lost });
  port.close();
});
