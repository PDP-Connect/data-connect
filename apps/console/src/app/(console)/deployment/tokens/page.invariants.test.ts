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
const PAGE_FILE = `${HERE}technical/page.tsx`;
const TOKEN_LIST_FILE = `${HERE}token-access-list.tsx`;
const ACTIONS_FILE = `${HERE}actions.ts`;

const BOUNDARY_HEADING_RE = /operator and trusted-agent access only/i;
const TRUSTED_AGENT_FRAMING_RE = /trusted local agents?/i;
const OWNER_AGENT_COMMAND_RE = /pdpp owner-agent onboard/;
const OWNER_AGENT_CREDENTIAL_RE = /--client-name[\s\S]*local assistant/;
const NO_BEARER_CHAT_RE = /No bearer needs to be\s+pasted\s+into chat/i;
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
  assert.match(src, /<summary[^>]*>\s*Details\s*<\/summary>/);
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
  // Settings repair brief, decision 2: this list is for scripts and tools, distinct from session tokens.
  assert.match(page, /title="Tokens for scripts and tools"/);
  assert.doesNotMatch(page, /title="Access tokens"/);
  assert.match(page, /<PageHeader title="Tokens for scripts and tools" \/>/);
  assert.match(page, /For scripts and tools that read your data without signing in\./);
  // Settings repair brief, decision 3: the store drops the secret after the page reads it
  // (see the flow-store tests below), so the page may say it is shown once.
  assert.match(page, /Copy it now\. You won't see it again\./);
  assert.doesNotMatch(page, /until DataConnect restarts/);
  assert.match(page, /takeOwnerBootstrapFlow\(params\.flow\)/);
  assert.doesNotMatch(page, /getOwnerBootstrapFlow\(params\.flow\)/);
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

async function withFlowStore(flows: Record<string, unknown>[], run: () => void | Promise<void>) {
  const state = globalThis as typeof globalThis & { __pdppOwnerBootstrapFlows?: Map<string, unknown> };
  const previous = state.__pdppOwnerBootstrapFlows;
  state.__pdppOwnerBootstrapFlows = new Map(flows.map((flow) => [flow.flowId as string, flow]));
  try {
    await run();
  } finally {
    state.__pdppOwnerBootstrapFlows = previous;
  }
}

function fakeFlow(flowId: string, startedAt: Date, token: string | null) {
  return {
    flowId,
    startedAt: startedAt.toISOString(),
    status: token ? "token_issued" : "pending_approval",
    token,
    tokenResponse: token ? { access_token: token } : null,
  };
}

mock.module("server-only", { exports: {} });

test("an issued secret is shown once: the second read of the flow gets no token", async () => {
  const { getOwnerBootstrapFlow, takeOwnerBootstrapFlow } = await import("../../lib/operator-bootstrap.ts");
  const token = "placeholder-not-a-real-secret";
  await withFlowStore([fakeFlow("flow-issued", new Date(), token)], () => {
    const first = takeOwnerBootstrapFlow("flow-issued");
    assert.equal(first?.token, token);
    const second = takeOwnerBootstrapFlow("flow-issued");
    assert.ok(second, "the flow itself stays so its transcript can still render");
    assert.equal(second.token, null);
    assert.equal(second.tokenResponse, null, "the raw token response also holds the secret");
    assert.equal(getOwnerBootstrapFlow("flow-issued")?.token, null);
  });
});

test("reading a flow before its token is issued does not change it", async () => {
  const { takeOwnerBootstrapFlow } = await import("../../lib/operator-bootstrap.ts");
  await withFlowStore([fakeFlow("flow-pending", new Date(), null)], () => {
    const before = takeOwnerBootstrapFlow("flow-pending");
    assert.equal(before?.status, "pending_approval");
    assert.equal(takeOwnerBootstrapFlow("flow-pending"), before);
  });
});

test("a flow older than 15 minutes is dropped whenever the store is touched", async () => {
  const { getOwnerBootstrapFlow, OWNER_BOOTSTRAP_FLOW_TTL_MS } = await import("../../lib/operator-bootstrap.ts");
  assert.equal(OWNER_BOOTSTRAP_FLOW_TTL_MS, 15 * 60 * 1000);
  const start = new Date("2026-11-25T12:00:00.000Z");
  mock.timers.enable({ apis: ["Date"], now: start });
  try {
    await withFlowStore(
      [fakeFlow("flow-old", start, "old-placeholder"), fakeFlow("flow-new", new Date(start.getTime() + 60_000), null)],
      () => {
        mock.timers.tick(14 * 60 * 1000);
        assert.equal(getOwnerBootstrapFlow("flow-old")?.token, "old-placeholder");
        mock.timers.tick(60 * 1000 + 1);
        // Reading the newer flow touches the store, which drops the older one.
        assert.ok(getOwnerBootstrapFlow("flow-new"));
        const state = globalThis as typeof globalThis & { __pdppOwnerBootstrapFlows?: Map<string, unknown> };
        assert.equal(state.__pdppOwnerBootstrapFlows?.has("flow-old"), false);
        assert.equal(getOwnerBootstrapFlow("flow-old"), null);
      }
    );
  } finally {
    mock.timers.reset();
  }
});

test("the token is checked at issuance, because it cannot be checked after the page shows it", async () => {
  const actions = await readFile(ACTIONS_FILE, "utf8");
  assert.match(actions, /await exchangeOwnerBootstrapToken\(flow\.flowId\);\s*\/\/[^\n]*\n[^\n]*\n\s*await introspectOwnerBootstrapToken\(flow\.flowId\);/);
  // The on-demand button would always fail once the token is dropped, so it is gone.
  assert.doesNotMatch(actions, /introspectOwnerTokenFlowAction/);
});
