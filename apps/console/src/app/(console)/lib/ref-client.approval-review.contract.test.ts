// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const PAGE_FILE = `${HERE}../grants/approvals/[approvalId]/page.tsx`;
const ERROR_CLEARS_CONFIRM_RE = /confirm=\{!query\.approval_error && query\.confirm === "1"\}/;

test("source: approval error clears confirmation before rerendering the materialized review", async () => {
  const src = await readFile(PAGE_FILE, "utf8");
  assert.match(src, ERROR_CLEARS_CONFIRM_RE);
});
