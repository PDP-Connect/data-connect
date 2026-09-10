// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Hostile stand-in for consent-handoff-restart-server-fixture.ts: reports
 * `ready`, answers the go line, then holds a referenced handle open
 * forever — a stand-in for a server whose close wedges. Used by
 * test/security-consent-token-handoff-fixture-lifecycle.test.ts to prove
 * the parent helper kills a child that will not exit on its own, rather
 * than abandoning it as an orphan.
 */
import { createInterface } from "node:readline";

process.stdout.write(`${JSON.stringify({ asPort: 0, ready: true })}\n`);

const rl = createInterface({ input: process.stdin });
await new Promise<string>((resolve) => {
  rl.once("line", resolve);
});
rl.close();
process.stdout.write(`${JSON.stringify({ code: "cex_never_exits" })}\n`);

// Never resolves, and stays referenced, so this process cannot exit on
// its own. Only the parent's kill can end it.
await new Promise(() => {
  setInterval(() => {}, 1000);
});
