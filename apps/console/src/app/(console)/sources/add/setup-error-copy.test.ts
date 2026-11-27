// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { setupErrorCopy } from "./setup-error-copy.ts";

const START_ROUTE = fileURLToPath(new URL("../../connect/browser-session/[connectorId]/start/route.ts", import.meta.url));

test("setup error codes map to fixed sentences and never expose URL text", () => {
  assert.equal(setupErrorCopy("not-browser"), "This data source does not use browser setup.");
  assert.equal(setupErrorCopy("not-self-service"), "This data source is not available for setup here.");
  assert.equal(setupErrorCopy("user supplied text"), "That setup could not start. Try again.");
});

// Brief decision 7: setup start routes pass codes, and the page maps codes to fixed copy.
test("browser setup redirects pass short error codes", async () => {
  const source = await readFile(START_ROUTE, "utf8");
  assert.match(source, /\/sources\/add\?error=not-browser/);
  assert.match(source, /\/sources\/add\?error=not-self-service/);
  assert.doesNotMatch(source, /\/sources\/add\?error=\$\{encodeURIComponent/);
});
