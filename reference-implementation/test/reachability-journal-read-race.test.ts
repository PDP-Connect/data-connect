// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
// A read can fetch a start's "applying" record just before the start settles and
// leaves the running set. It must not then rewrite that record as a crash orphan.
// One libuv thread queues the reads behind the journal's fsyncs, which is what
// opens the window on a loaded machine.
process.env.UV_THREADPOOL_SIZE = "1";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate as waitTurn } from "node:timers/promises";
import test from "node:test";
import type { RouteView as Route } from "@tnunamak/gozar";
import { fakeRouteScenarios } from "@tnunamak/gozar/testing";
import { ReachabilityOperations } from "../server/reachability/operations.ts";

const seed = fakeRouteScenarios().find((route) => route.handle.kind === "attached" && route.published)!;

// In-flight threadpool fs work, as visible from the outside. `getActiveResourcesInfo`
// does not report libuv requests, and no supported API exposes them, so this reads
// the long-standing internal accessor. The settle wait bounds every use with a
// deadline, so a changed or removed accessor can only fail the test loudly.
function pendingFsRequests(): boolean {
  const requests = (process as unknown as { _getActiveRequests?(): Array<{ constructor?: { name?: string } }> })
    ._getActiveRequests?.();
  return requests?.some((request) => request.constructor?.name?.startsWith("FSReq")) === true;
}

test("reads that race a start's completion never leave it unsettled", async () => {
  let bad = 0;
  for (let round = 0; round < 30; round++) {
    const root = await mkdtemp(join(tmpdir(), "reachability-race-"));
    try {
      const operations = new ReachabilityOperations(root, true);
      const ids: string[] = [];
      for (let k = 0; k < 4; k++) {
        const { operationId } = await operations.start("start", null, async (id) => ({ ...seed, handle: { id: `r${round}-${k}`, generation: 1, kind: "session" }, operationId: id }) as Route);
        ids.push(operationId);
      }
      // The settle wait is a condition, not a fixed read count. On a loaded
      // machine the journal's fsyncs outlast any number of cached reads, so a
      // start whose settlement write is still in flight is legitimately applying.
      // Judging it after a fixed number of list() rounds was the CI flake; a
      // settlement that never settles is the real defect, so the wait fails
      // loudly on a deadline instead of falling through.
      const deadline = Date.now() + 10_000;
      for (;;) {
        const records = await operations.list();
        if (records.every((record) => record.stage === "settled")) break;
        assert.ok(Date.now() < deadline, `round ${round}: starts never settled: ${records.map((record) => record.stage).join(",")}`);
      }
      for (const id of ids) if ((await operations.read(id)).stage !== "settled") bad++;
      // A record that reads settled proves only that its rename ran: the same
      // write still fsyncs the journal's directory, and that tail is what a
      // premature scratch removal would race — the rename or dir fsync would
      // fail with ENOENT, and the failure path would recreate the root to
      // record its unknown-possibly-live verdict, leaking the scratch dir.
      // libuv's pending fs requests are the only externally visible trace of
      // that tail, so wait for them to drain before removing the directory.
      while (pendingFsRequests()) {
        assert.ok(Date.now() < deadline, `round ${round}: journal writes never drained`);
        await waitTurn();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
  assert.equal(bad, 0);
});
