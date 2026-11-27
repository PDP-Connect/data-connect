// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

// The server has no GET for `/_ref/connections/:id/schedule` (only PUT and DELETE), so a read through
// it answered 404, which the pages took for "this source has no schedule" and said "only when you ask"
// for a source that syncs every hour.
test("a source's schedule is read from the route the server answers, with the account as a query value", async () => {
  const source = await readFile(fileURLToPath(new URL("./ref-client.ts", import.meta.url)), "utf8");
  const fn = source.slice(source.indexOf("export async function getConnectorSchedule"));
  const body = fn.slice(0, fn.indexOf("\n}\n"));
  assert.doesNotMatch(body, /\/_ref\/connections\//);
  assert.match(body, /\/_ref\/connectors\/\$\{encodeURIComponent\(connectorId\)\}\/schedule/);
  assert.match(body, /connector_instance_id/);
});
