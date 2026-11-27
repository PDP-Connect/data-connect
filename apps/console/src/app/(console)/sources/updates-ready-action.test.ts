// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import { runUpdatesSequentially } from "./updates-ready-action.ts";

// DIRECTION.md, “Data sources /sources”: updates run one after another and one failure does not stop the next kind.
test("runs every update sequentially after a failure", async () => {
  const order: string[] = [];
  const result = await runUpdatesSequentially(
    [
      { connectorId: "alpha", sourceNames: ["Calendar"] },
      { connectorId: "beta", sourceNames: ["Mail"] },
      { connectorId: "gamma", sourceNames: ["Photos"] },
    ],
    async (connectorId) => {
      order.push(`start:${connectorId}`);
      if (connectorId === "beta") throw new Error("failure");
      order.push(`finish:${connectorId}`);
      return { ok: true };
    }
  );
  assert.deepEqual(order, ["start:alpha", "finish:alpha", "start:beta", "start:gamma", "finish:gamma"]);
  assert.deepEqual(result, [
    { ok: true, sourceNames: ["Calendar"] },
    { ok: false, sourceNames: ["Mail"] },
    { ok: true, sourceNames: ["Photos"] },
  ]);
});
