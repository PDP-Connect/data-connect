// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { mock, test } from "node:test";
let fail = false;
const cursors: (string | undefined)[] = [];
mock.module("../lib/ref-client.ts", {
  namedExports: {
    listConnectorSummaries: async ({ cursor }: { cursor?: string }) => {
      cursors.push(cursor);
      if (fail && cursor) throw new Error("inventory unavailable");
      return {
        data: [
          {
            connection_id: cursor ? "personal" : "work",
            connector_id: "gmail",
            connector_display_name: "Gmail",
            display_name: cursor ? "Gmail (personal)" : "Gmail (work)",
          },
        ],
        has_more: !cursor,
        next_cursor: cursor ? undefined : "second",
      };
    },
  },
});
const { loadSourceNames } = await import("./load-source-names.ts");
test("account names include every inventory page", async () => {
  assert.deepEqual([...(await loadSourceNames()).values()], ["Gmail (work)", "Gmail (personal)"]);
  assert.deepEqual(cursors, [undefined, "second"]);
});
test("a partial inventory cannot claim an app reads every source", async () => {
  fail = true;
  assert.equal((await loadSourceNames()).size, 0);
});
