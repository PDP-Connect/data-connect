// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";

const PAGE_FILE = fileURLToPath(new URL("./page.tsx", import.meta.url));
const BODY_FILE = fileURLToPath(new URL("./first-sync-body.tsx", import.meta.url));

// Design "Page 3" (repair round 1): the result is the page heading beside one logo, there is no
// "Back to Data sources", and the schedule is read the way the data source's own page reads it.
test("setup status shows one headline with one logo and no Details fold (design Page 3, banned list 1 and 4)", async () => {
  const page = await readFile(PAGE_FILE, "utf8");
  const body = await readFile(BODY_FILE, "utf8");
  assert.match(page, /<FirstSyncBody/);
  assert.match(body, /headlineFor\(outcome, name\)/);
  assert.equal((body.match(/<ConnectHeader/g) ?? []).length, 1);
  assert.doesNotMatch(body, /<ConnectorMark/);
  assert.doesNotMatch(page + body, /<details/);
  assert.doesNotMatch(page + body, /Back to Data sources/);
  assert.match(page, /getConnectorSchedule\(status\.connector_id, \{ connectorInstanceId: status\.connection_id \}\)/);
  assert.match(page, /resumeConnectionAction/);
});
