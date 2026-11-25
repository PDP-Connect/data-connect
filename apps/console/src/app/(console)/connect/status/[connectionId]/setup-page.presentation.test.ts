// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";

const PAGE_FILE = fileURLToPath(new URL("./page.tsx", import.meta.url));
const BODY_FILE = fileURLToPath(new URL("./first-sync-body.tsx", import.meta.url));

// Design "Page 3": one sentence for the outcome, the right next button, no fold except "What went wrong".
test("setup status shows one headline with one logo and no Details fold (design Page 3, banned list 1 and 4)", async () => {
  const page = await readFile(PAGE_FILE, "utf8");
  const body = await readFile(BODY_FILE, "utf8");
  assert.match(page, /<FirstSyncBody/);
  assert.match(body, /headlineFor\(outcome, name\)/);
  assert.equal((body.match(/<ConnectorMark/g) ?? []).length, 1);
  assert.doesNotMatch(page + body, /<details/);
  assert.match(page, /Back to Data sources/);
  assert.match(page, /sources\/add|getConnectorSchedule/);
});
