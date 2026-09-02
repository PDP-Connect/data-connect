// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Render-layer lock-in for the picker's per-stream scope controls.
 *
 * The picker used to grant every field of every checked stream with no date
 * bound. These tests pin the two properties that make the new controls safe
 * rather than merely present:
 *
 *   1. a control is rendered only where the declaration supports it —
 *      `selection.fields` for fields, `consent_time_field` for dates. Offering
 *      either where the manifest lacks it produces a 400 at issuance, after
 *      the owner has already chosen;
 *   2. schema-required fields render checked AND disabled (spec-core.md:764
 *      makes them the consent floor), so the owner sees what they cannot
 *      exclude rather than unchecking it and being overruled silently.
 *
 * The disclosure stays closed by default, so the common path — check a stream,
 * get all of it — is unchanged.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { canonicalConnectorKey } from "../server/connector-key.ts";
import {
  encodeHostedMcpSelection,
  encodeHostedMcpStreamSelection,
  hostedMcpSourceKey,
} from "../server/hosted-mcp-selection.ts";
import { scopeFieldsInputName, scopeSinceInputName } from "../server/hosted-mcp-stream-scope.ts";
import { escapeHtml, renderKeyValueList } from "../server/hosted-ui.ts";
import {
  type ConsentPickerCapabilities,
  type ConsentUiRenderer,
  renderHostedMcpSourceSelection,
} from "../server/routes/as-consent-ui-helpers.ts";

const ui: ConsentUiRenderer = {
  escapeHtml,
  renderActionRow: (actions) => actions.map((a) => `<button>${escapeHtml(a.label)}</button>`).join("\n"),
  renderHostedDocument: ({ body }) => `<!doctype html><html><body>${body}</body></html>`,
  renderKeyValueList,
  renderPageIntro: ({ title }) => `<h1>${escapeHtml(title)}</h1>`,
  renderResultState: ({ title, body }) => `<div>${escapeHtml(title)}${escapeHtml(body)}</div>`,
  renderSurface: ({ children }) => `<section>${children}</section>`,
};

const CONNECTOR_ID = "https://registry.pdpp.dev/connectors/chatgpt";

// Three streams covering the capability matrix: both axes, fields only, and
// neither. Shaped like the real ChatGPT manifest.
const MANIFEST = {
  display_name: "ChatGPT",
  source_declaration: { source: { id: CONNECTOR_ID, kind: "connector" } },
  streams: [
    {
      consent_time_field: "create_time",
      description: "Your conversations",
      name: "messages",
      schema: {
        properties: { author: {}, content: {}, conversation_id: {}, create_time: {}, id: {} },
        required: ["id", "conversation_id"],
      },
      selection: { fields: true },
    },
    {
      description: "Saved memories",
      name: "memories",
      schema: { properties: { content: {}, id: {} }, required: ["id"] },
      selection: { fields: true },
    },
    {
      description: "Settings",
      name: "settings",
      schema: { properties: { theme: {} }, required: [] },
      selection: { fields: false },
    },
  ],
};

const AUTHORIZE_QUERY = {
  client_id: "client_demo",
  code_challenge: "a".repeat(43),
  code_challenge_method: "S256",
  redirect_uri: "https://client.example/callback",
  response_type: "code",
  scope: "mcp",
  state: "scope-render-test",
};

const SOURCE_KEY = hostedMcpSourceKey({ connectionId: "cin_1", connectorId: CONNECTOR_ID });

function makeCaps(): ConsentPickerCapabilities {
  return {
    canonicalConnectorKey,
    encodeHostedMcpSelection,
    encodeHostedMcpStreamSelection,
    getConnectorManifest: async (connectorId: string) => (connectorId === CONNECTOR_ID ? MANIFEST : null),
    hostedMcpSourceKey,
    isInternalConnectorId: () => false,
    listActiveBindingsForGrant: async () => [{ connectorInstanceId: "cin_1" }],
    listRegisteredConnectorIds: async () => [CONNECTOR_ID],
    listStreamsWithRecords: async () => MANIFEST.streams.map((s) => s.name),
    projectBindingForWire: () => ({ connection_id: "cin_1", display_name: "Personal" }),
  } as unknown as ConsentPickerCapabilities;
}

function renderPicker(): Promise<string> {
  return renderHostedMcpSourceSelection("owner_local", AUTHORIZE_QUERY, "csrf-token", "PDPP", makeCaps(), ui, {});
}

test("a stream declaring both capabilities gets both controls", async () => {
  const html = await renderPicker();

  assert.match(html, /data-hosted-mcp-stream-scope[^>]*data-stream="messages"/, "messages gets a scope disclosure");
  assert.ok(html.includes(scopeFieldsInputName(SOURCE_KEY, "messages")), "field checkboxes are named per stream");
  assert.ok(html.includes(scopeSinceInputName(SOURCE_KEY, "messages")), "a start-date input is offered");
});

test("schema-required fields are checked and disabled, not hidden", async () => {
  const html = await renderPicker();

  // spec-core.md:764 — required fields are the consent floor. The owner must
  // be able to see what they cannot exclude.
  assert.match(
    html,
    /hosted-ui-scope-field--required[^>]*><input type="checkbox" checked disabled \/>/,
    "required fields render checked and disabled"
  );
  assert.match(html, /always included/, "and are labelled as such");
});

test("only optional fields are submittable, so the floor cannot be unchecked", async () => {
  const html = await renderPicker();
  const fieldsName = scopeFieldsInputName(SOURCE_KEY, "messages");
  const submittable = [...html.matchAll(new RegExp(`name="${fieldsName}" value="([^"]+)"`, "g"))].map((m) => m[1]);

  assert.deepEqual(submittable.sort(), ["author", "content", "create_time"], "required fields carry no form value");
});

test("a stream with no consent_time_field is offered no date control", async () => {
  const html = await renderPicker();

  // spec-core.md:547 — absence is the normative signal that the stream has no
  // temporal scope. Offering the control anyway would 400 at issuance.
  assert.equal(html.includes(scopeSinceInputName(SOURCE_KEY, "memories")), false, "no date input for memories");
  assert.ok(html.includes(scopeFieldsInputName(SOURCE_KEY, "memories")), "but its fields are still narrowable");
});

test("a stream that supports neither axis renders no scope control at all", async () => {
  const html = await renderPicker();

  // `settings` declares selection.fields: false and no consent_time_field.
  assert.equal(
    /data-hosted-mcp-stream-scope[^>]*data-stream="settings"/.test(html),
    false,
    "silence is the correct rendering of an inapplicable control"
  );
});

test("the disclosure is closed by default, so the common path is unchanged", async () => {
  const html = await renderPicker();
  const disclosure = html.match(/<details class="hosted-ui-scope"[^>]*>/g) ?? [];

  assert.ok(disclosure.length > 0, "the disclosures exist");
  assert.equal(
    disclosure.some((tag) => tag.includes(" open")),
    false,
    "checking a stream still means 'all of it' without any extra clicks"
  );
});

test("the owner never reads protocol vocabulary on the scope controls", async () => {
  const html = await renderPicker();

  for (const jargon of ["time_range", "consent_time_field", "selection.fields", "schema.required"]) {
    assert.equal(html.includes(jargon), false, `${jargon} must not reach the owner surface`);
  }
  // The time field is rendered as a verb, per spec-core.md:545.
  assert.match(html, /created on or after/, "temporal scope reads in the stream's own terms");
});
