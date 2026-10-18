// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";

const OPERATOR_RUNS_FILE = fileURLToPath(new URL("./operator-runs.ts", import.meta.url));

test("source: operator run helpers expose schedule controls alongside connection-scoped controls", async () => {
  const src = await readFile(OPERATOR_RUNS_FILE, "utf8");
  assert.match(src, /export function saveConnectionSchedule\(/);
  assert.match(src, /export function pauseConnectionSchedule\(connectionId: string\)/);
  assert.match(src, /export function resumeConnectionSchedule\(connectionId: string\)/);
  assert.match(src, /export async function deleteConnectionSchedule\(connectionId: string\)/);
});
