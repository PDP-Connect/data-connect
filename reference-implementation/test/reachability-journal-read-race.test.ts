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
      // Let every start's effect return, so each has queued its settlement write.
      // The effects here are plain promises, so one macrotask turn is enough.
      await waitTurn();
      // Reads race the settlements still in flight. A read may see a start as
      // applying, but never as a crash orphan: that stage is a verdict about a
      // start that is no longer running, and these starts are running or settled.
      for (let read = 0; read < 100; read++) {
        for (const record of await operations.list()) if (record.stage === "unknown-possibly-live") bad++;
      }
      // Every settlement write is a chain the journal owns, so it reports when the
      // last one has finished, rename and directory fsync included. Only then is
      // the scratch directory safe to remove, and every record has settled.
      await operations.idle();
      for (const id of ids) if ((await operations.read(id)).stage !== "settled") bad++;
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
  assert.equal(bad, 0);
});
