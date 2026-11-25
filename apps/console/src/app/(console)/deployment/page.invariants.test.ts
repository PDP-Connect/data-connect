// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Source-regex guard for the operator-console deployment page.
 *
 * The page is a retrieval-diagnostics surface. Agent connection setup lives on
 * /connect, which already renders the MCP URL alongside the per-client
 * commands; the deployment page deliberately does NOT repeat that card.
 *
 * Spec: openspec/specs/reference-implementation-architecture/spec.md
 *       (Operator deployment diagnostics surface)
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const PAGE_FILE = `${HERE}page.tsx`;

const CONNECT_AGENT_CARD_RE = /ConnectAgentCard/;
const TOKENS_LINK_RE = /href="\/deployment\/tokens"/;

test("deployment page does not repeat the connect-an-AI-app card", async () => {
  // The card is just an MCP URL with a copy button, and /connect already
  // renders that URL plus the per-client setup commands. Two copies of the
  // same endpoint on two surfaces is one more place to drift.
  const src = await readFile(PAGE_FILE, "utf8");
  assert.doesNotMatch(src, CONNECT_AGENT_CARD_RE);
});

test("deployment page links to the tokens issuance surface", async () => {
  // Brief settings-pages, decision 3: the server page keeps a route to Access tokens.
  // Settings repair brief, decision 2: the route says what these script and tool tokens are for.
  const src = await readFile(PAGE_FILE, "utf8");
  assert.match(src, TOKENS_LINK_RE);
  assert.match(src, /Tokens for scripts and tools/);
});

test("server page leads with reachability and folds diagnostics under Details", async () => {
  const src = await readFile(PAGE_FILE, "utf8");
  // Brief settings-pages, decision 2: plain server status comes before the checks and technical details.
  // Settings repair brief, decision 1: reachability comes from the browser-side address check.
  assert.match(src, /title="Server"/);
  assert.doesNotMatch(src, /The server is reachable/);
  assert.match(src, /<ServerChecks inputs=\{extractReadinessInputs\(report\)\} \/>/);
  assert.match(src, /<summary[^>]*>Details<\/summary>/);
});

test("the Details fold opens when the rebuild action returns, so its result is seen", async () => {
  // RAISE-RULES.md 6: a failed action shows its sentence; the rebuild notice and
  // error render inside Details, so the fold must open on ?notice= / ?error=.
  const src = await readFile(PAGE_FILE, "utf8");
  assert.match(src, /open=\{Boolean\(params\.error\) \|\| params\.notice === "dataset_summary_rebuilt"\}/);
});
