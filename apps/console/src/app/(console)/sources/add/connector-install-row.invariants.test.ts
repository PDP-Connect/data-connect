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
const SINGLE_LIFECYCLE_STATUS_RE = /data-testid="connector-package-status"/;
const NO_DUPLICATE_TIER_RE = /data-testid="connector-tier"/;
// PAGE-RULES 4: technical package identity is inside the folded Details group.
const DIGEST_DISCLOSURE_RE = /Details/;
const UNINSTALL_RE = /uninstallConnectorAction/;
const UNINSTALL_CONFIRM_RE = /window\.confirm\("Uninstall this package\? This is allowed only when no data sources use it\."\)/;
const UNINSTALL_REFUSAL_RE = /if \(!result\.ok\) \{\s+setMessage\(\{ message: result\.message, tone: "error" \}\)/;

// RAISE-RULES 5: destructive actions ask for confirmation without exposing an internal package ID.
test("connector install row keeps mutation feedback inline and non-optimistic", async () => {
  const source = await readFile(ROW_FILE, "utf8");
  assert.match(source, CLIENT_DIRECTIVE_RE);
  assert.match(source, TRANSITION_RE);
  assert.match(source, PENDING_DISABLED_RE);
  assert.match(source, FEEDBACK_ROLE_RE);
  assert.match(source, FEEDBACK_ROLE_PROP_RE);
  assert.match(source, REFRESH_RE);
  assert.match(source, ACTION_RE);
  assert.match(source, SINGLE_LIFECYCLE_STATUS_RE);
  assert.match(source, DIGEST_DISCLOSURE_RE);
  assert.match(source, UNINSTALL_RE);
  assert.match(source, UNINSTALL_CONFIRM_RE);
  assert.doesNotMatch(source, /window\.confirm\([^)]*\$\{(?:connectorId|connectorKey)\}/);
  assert.match(source, UNINSTALL_REFUSAL_RE);
  assert.doesNotMatch(source, NO_DUPLICATE_TIER_RE);
});
