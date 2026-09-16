// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROW_FILE = fileURLToPath(new URL("./connector-install-row.tsx", import.meta.url));
const CLIENT_DIRECTIVE_RE = /^"use client";/;
const TRANSITION_RE = /useTransition\(\)/;
const PENDING_DISABLED_RE = /disabled=\{isPending\}/;
const FEEDBACK_ROLE_RE = /const feedbackRole = message\?\.tone === "error" \? "alert" : "status";/;
const FEEDBACK_ROLE_PROP_RE = /role=\{feedbackRole\}/;
const REFRESH_RE = /router\.refresh\(\)/;
const ACTION_RE = /installConnectorAction|updateConnectorAction/;

test("connector install row keeps mutation feedback inline and non-optimistic", async () => {
  const source = await readFile(ROW_FILE, "utf8");
  assert.match(source, CLIENT_DIRECTIVE_RE);
  assert.match(source, TRANSITION_RE);
  assert.match(source, PENDING_DISABLED_RE);
  assert.match(source, FEEDBACK_ROLE_RE);
  assert.match(source, FEEDBACK_ROLE_PROP_RE);
  assert.match(source, REFRESH_RE);
  assert.match(source, ACTION_RE);
});
