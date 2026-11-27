// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mock, test } from "node:test";
import baseline from "./history-action-contract.json" with { type: "json" };
const calls: unknown[] = [];
mock.module("next/cache", { namedExports: { revalidatePath: (path: string) => calls.push(["refresh", path]) } });
mock.module("../../lib/dashboard-access.ts", { namedExports: { requireDashboardAccess: async (path: string) => calls.push(["access", path]) } });
mock.module("../../lib/owner-token.ts", { namedExports: { ReferenceServerUnreachableError: class extends Error {} } });
mock.module("../../lib/operator-runs.ts", { namedExports: {
  cancelRun: async (id: string) => { calls.push(["cancel", id]); return { status: "cancel_requested" }; },
  submitRunInteraction: async (id: string, body: unknown) => calls.push(["answer", id, body]),
} });
for (const [file, digest] of Object.entries(baseline)) test(`${file} remains byte-identical`, () => {
  assert.equal(createHash("sha256").update(readFileSync(new URL(file, import.meta.url))).digest("hex"), digest);
});
test("stop and answer preserve the existing server arguments and access checks", async () => {
  const actions = await import("./actions.ts");
  calls.length = 0;
  await actions.cancelRunAction(" sample sync ");
  const form = new FormData();
  form.set("run_id", "sample sync"); form.set("interaction_id", "step"); form.set("status", "success"); form.set("code", "123456");
  await actions.submitRunInteractionAction({ error: null, status: null }, form);
  assert.deepEqual(calls, [
    ["access", "/syncs/sample%20sync"], ["cancel", "sample sync"], ["refresh", "/syncs/sample sync"],
    ["access", "/syncs/sample%20sync"], ["answer", "sample sync", { data: { code: "123456" }, interactionId: "step", status: "success" }], ["refresh", "/syncs/sample sync"],
  ]);
});
