// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
// idle() is the journal's own report that no write chain is in flight. It must
// wait for a held settlement, and a failed settlement must only end the wait.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate as waitTurn } from "node:timers/promises";
import test, { mock } from "node:test";
import type { RouteView as Route } from "@tnunamak/gozar";
import { fakeRouteScenarios } from "@tnunamak/gozar/testing";
import { ReachabilityOperations, type OperationRecord } from "../server/reachability/operations.ts";

const seed = fakeRouteScenarios().find((route) => route.handle.kind === "attached" && route.published)!;
const effect = async (operationId: string) =>
  ({ ...seed, handle: { id: "r-idle", generation: 1, kind: "session" }, operationId }) as Route;

type Writer = { write(record: OperationRecord): Promise<void> };

async function withJournal(run: (operations: ReachabilityOperations, writer: Writer) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "reachability-idle-"));
  try {
    const operations = new ReachabilityOperations(root, true);
    await run(operations, operations as unknown as Writer);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("idle resolves at once when no write is in flight", async () => {
  await withJournal(async (operations) => {
    await operations.idle();
  });
});

test("idle waits for a settlement whose write is held", async () => {
  await withJournal(async (operations, writer) => {
    const realWrite = writer.write.bind(operations);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let writes = 0;
    let held!: () => void;
    const reachedHold = new Promise<void>((resolve) => {
      held = resolve;
    });
    // The first write is start()'s durable intent; the second is the settlement, held before it lands.
    writer.write = async (record) => {
      writes += 1;
      if (writes === 2) {
        held();
        await gate;
      }
      await realWrite(record);
    };
    const { operationId } = await operations.start("start", null, effect);
    await waitTurn();
    let idle = false;
    const waiting = operations.idle().then(() => {
      idle = true;
    });
    await reachedHold;
    await waitTurn();
    await waitTurn();
    assert.equal(idle, false, "idle must wait while the settlement is held");
    release();
    await waiting;
    assert.equal((await operations.read(operationId)).stage, "settled");
  });
});

test("idle resolves after a settlement that fails", async () => {
  await withJournal(async (operations, writer) => {
    const realWrite = writer.write.bind(operations);
    let writes = 0;
    // Intent lands; every settlement write after it fails, including the failure path's own.
    writer.write = async (record) => {
      writes += 1;
      if (writes > 1) throw new Error("disk gone");
      await realWrite(record);
    };
    const logged = mock.method(console, "error", () => undefined);
    try {
      await operations.start("start", null, effect);
      await waitTurn();
      await operations.idle();
      assert.ok(writes >= 2, "a settlement write was attempted and failed");
    } finally {
      logged.mock.restore();
    }
  });
});
