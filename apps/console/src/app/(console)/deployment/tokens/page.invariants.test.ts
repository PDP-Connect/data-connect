// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Source-regex guard for the owner-token issuance page.
 *
 * The boundary this page describes is load-bearing: tokens issued here are
 * full owner bearers for `/v1/*`, the right shape for the operator or a
 * trusted local agent that runs on the operator's behalf, and the explicit
 * wrong shape for ordinary MCP clients (Claude, ChatGPT, third-party
 * agents). The hosted MCP endpoint at `/mcp` rejects owner bearers on
 * purpose. If that framing regresses to generic "issue a token" copy, the
 * dashboard quietly trains operators to paste owner credentials into MCP
 * clients — undoing the scoped-grant story.
 *
 * Spec: openspec/specs/mcp-adapter/spec.md (Hosted MCP rejects owner bearers)
 *       openspec/specs/reference-agent-access-workflow/spec.md (agents SHALL
 *       use scoped client grants instead of owner tokens)
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test, { mock } from "node:test";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const PAGE_FILE = `${HERE}page.tsx`;
const TOKEN_LIST_FILE = `${HERE}token-access-list.tsx`;
const ACTIONS_FILE = `${HERE}actions.ts`;

const BOUNDARY_HEADING_RE = /operator and trusted-agent access only/i;
const TRUSTED_AGENT_FRAMING_RE = /trusted local agents?/i;
const OWNER_AGENT_COMMAND_RE = /pdpp owner-agent onboard/;
const OWNER_AGENT_CREDENTIAL_RE = /--client-name[\s\S]*local assistant/;
const NO_BEARER_CHAT_RE = /No bearer needs to be\s+.*pasted into chat/i;
const MANUAL_DEBUG_RE = /Manual\/debug bearer/i;
const MCP_SCOPED_FLOW_HINT_RE = /\/mcp/;
const ORDINARY_MCP_CLIENTS_RE = /ordinary MCP clients/i;
const MCP_REJECTS_OWNER_RE = /rejects owner bearers/i;

const STALE_GENERIC_DESCRIPTION_RE = /Issue an owner bearer for the reference RS\.$/m;
const STALE_PRIMARY_ISSUE_BUTTON_RE = />\s*Issue token\s*</;

test("tokens page calls out the operator/trusted-agent boundary in copy", async () => {
  const src = await readFile(PAGE_FILE, "utf8");
  assert.match(src, BOUNDARY_HEADING_RE);
  assert.match(src, TRUSTED_AGENT_FRAMING_RE);
});

test("tokens page keeps the owner-agent setup path inside Details", async () => {
  const src = await readFile(PAGE_FILE, "utf8");
  // Brief settings-pages, decision 3: operator-only setup details stay available under Details.
  assert.match(src, /<summary[^>]*>Details<\/summary>/);
  assert.match(src, OWNER_AGENT_COMMAND_RE);
  assert.match(src, OWNER_AGENT_CREDENTIAL_RE);
  assert.match(src, NO_BEARER_CHAT_RE);
  assert.match(src, MANUAL_DEBUG_RE);
});

test("tokens page names the ordinary-MCP-client path and that /mcp refuses owner bearers", async () => {
  const src = await readFile(PAGE_FILE, "utf8");
  assert.match(src, ORDINARY_MCP_CLIENTS_RE);
  assert.match(src, MCP_SCOPED_FLOW_HINT_RE);
  assert.match(src, MCP_REJECTS_OWNER_RE);
});

test("tokens page does not regress to the prior generic description", async () => {
  const src = await readFile(PAGE_FILE, "utf8");
  // The earlier copy ("Issue an owner bearer for the reference RS.") didn't
  // tell a fresh operator who this surface is for. Lock the sharper framing
  // in so a future polish pass doesn't quietly revert it.
  assert.doesNotMatch(src, STALE_GENERIC_DESCRIPTION_RE);
  assert.doesNotMatch(src, STALE_PRIMARY_ISSUE_BUTTON_RE);
});

// ─── owner-access reference contracts wiring (10.C) ───────────────────────

const RENAME_ACTION_RE = /action=\{renameOwnerTokenAction\}/;
const RENAME_INPUT_RE = /name="client_name"/;
const PER_TOKEN_REVOKE_ACTION_RE = /action=\{revokeOwnerClientTokenAction\}/;
const PER_TOKEN_HANDLE_RE = /name="token_id_public"/;
const RAW_TOKEN_ID_FIELD_RE = /name="token_id"[^_]/;
const TOKEN_ACCESS_TOKEN_RE = /token\.access_token/;
const TOKEN_ID_FIELD_RE = /\.token_id\b(?!_public)/;
// The drilldown must be gated on active_token_count > 1 so a single-token
// client is fully described by its row (no needless expansion).
const DRILLDOWN_GATE_RE = /active_token_count\s*>\s*1/;

test("tokens page wires the in-place rename action with a client_name field (10.C.1)", async () => {
  const src = await readFile(PAGE_FILE, "utf8");
  assert.match(src, RENAME_ACTION_RE);
  assert.match(src, RENAME_INPUT_RE);
});

test("tokens page wires the per-token drilldown revoke by public id, gated on >1 active token (10.C.2/10.C.3)", async () => {
  const [src, list] = await Promise.all([readFile(PAGE_FILE, "utf8"), readFile(TOKEN_LIST_FILE, "utf8")]);
  // RAISE-RULES.md 5: per-token revoke remains available and requires confirmation.
  assert.match(list, PER_TOKEN_REVOKE_ACTION_RE);
  assert.match(list, /ConfirmTokenRevoke/);
  // RAISE-RULES.md 5: the per-token revoke uses its public id and confirms before submit.
  assert.match(list, PER_TOKEN_HANDLE_RE);
  assert.doesNotMatch(list, RAW_TOKEN_ID_FIELD_RE);
  assert.match(src, DRILLDOWN_GATE_RE);
});

test("tokens page renders no raw bearer from the token drilldown (no-leak guard)", async () => {
  const src = await readFile(PAGE_FILE, "utf8");
  // The per-client token type exposes only a public id + issued/expiry facts;
  // there is no `.access_token` / raw bearer field to render for listed tokens.
  assert.doesNotMatch(src, TOKEN_ACCESS_TOKEN_RE);
  assert.doesNotMatch(src, TOKEN_ID_FIELD_RE);
});

test("access tokens page shows the promised list fields and copy-now secret sentence", async () => {
  const [page, list] = await Promise.all([readFile(PAGE_FILE, "utf8"), readFile(TOKEN_LIST_FILE, "utf8")]);
  // Brief settings-pages, decision 3: the list names access, creation, use time and one-time secret behavior.
  assert.match(page, /title="Access tokens"/);
  assert.match(page, /For scripts and tools that read your data without signing in\./);
  // The secret is not one-time (see the last test), so the page must not promise that.
  assert.doesNotMatch(page, /You will not see it again/);
  assert.match(page, /Copy it now\. This page shows it only until DataConnect restarts\./);
  assert.match(page, /Create access token/);
  assert.match(list, /What it can read/);
  assert.match(list, /Last used/);
  assert.match(list, /More actions for/);
  // DIRECTION.md Values: the rebuilt pages do not use the copper human color.
  assert.doesNotMatch(page, /--human|data-surface="human"/);
})

test("revoking an access token shows a named confirmation before submitting", async () => {
  const list = await readFile(TOKEN_LIST_FILE, "utf8");
  // RAISE-RULES.md 5: every revoke has a confirmation step that names its effect.
  // RAISE-RULES.md 4: the visible action names an access token in plain words.
  assert.match(list, /Revoke this access token/);
  assert.match(list, /role="alertdialog"/);
  assert.match(list, /This access token and its active credentials will stop working\./);
  assert.match(list, /Confirm revoke/);
  assert.match(list, /Cancel/);
})

test("unused token flow actions are removed", async () => {
  const actions = await readFile(ACTIONS_FILE, "utf8");
  // Brief settings-pages, decision 5: remove the four actions with no page caller.
  assert.doesNotMatch(actions, /export async function (start|approve|deny|exchange)OwnerTokenFlowAction/);
})

test("an issued secret can be read again from the same flow, so the page promises only 'until DataConnect restarts'", async () => {
  // The flow store is process memory with no eviction: a reload of
  // /deployment/tokens?flow=<id> renders the same secret again. If it ever
  // becomes consume-once, the page may say "You will not see it again." instead.
  mock.module("server-only", { exports: {} });
  const { getOwnerBootstrapFlow } = await import("../../lib/operator-bootstrap.ts");
  const fake = { flowId: "flow-test", token: "placeholder-not-a-real-secret" };
  const state = globalThis as typeof globalThis & { __pdppOwnerBootstrapFlows?: Map<string, unknown> };
  const previous = state.__pdppOwnerBootstrapFlows;
  state.__pdppOwnerBootstrapFlows = new Map([[fake.flowId, fake]]);
  try {
    assert.equal(getOwnerBootstrapFlow(fake.flowId)?.token, fake.token);
    assert.equal(getOwnerBootstrapFlow(fake.flowId)?.token, fake.token);
  } finally {
    state.__pdppOwnerBootstrapFlows = previous;
  }
});
