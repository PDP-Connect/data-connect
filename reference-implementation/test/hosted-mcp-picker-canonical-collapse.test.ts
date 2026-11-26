// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
// biome-ignore-all lint/performance/useTopLevelRegex: rejection assertions keep their expected error pattern local.

/**
 * Hosted MCP picker — one connector, one row, enforced by canonical
 * connector identity at the registration layer.
 *
 * `openspec/specs/agent-consent-bundling/spec.md` ("Hosted MCP connection
 * presentation SHALL use shared connector identity") requires that the hosted
 * MCP picker SHALL NOT show a duplicate of one connector as a separate
 * owner-facing source.
 *
 * The reference implementation satisfies this through ONE canonical path
 * rather than a second picker-level dedup mechanism: `registerConnector`
 * canonicalizes the manifest's `connector_id` via
 * `normalizeConnectorManifestForStorage` (auth.js) and upserts under the
 * canonical key with `ON CONFLICT (connector_id) DO UPDATE`. The registry-URL
 * spelling and the bare key therefore resolve to the same connector row.
 *
 * The server keeps no alias list: the four underscore ids older collectors
 * used (`claude_code`) are not rewritten here. The one-time data migration
 * renames stored rows.
 *
 * `listHostedMcpPickerRows` (server/index.js) enumerates exactly
 * `listRegisteredConnectorIds()`, so if the storage layer cannot hold two
 * rows for the same canonical connector, the picker cannot render a legacy
 * duplicate. This regression locks that invariant at the layer that actually
 * enforces it; the existing hosted-mcp-oauth picker-render tests cover the
 * 1:1 mapping from registered ids to picker rows.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { getConnectorManifest, listRegisteredConnectorIds, registerConnector } from "../server/auth.ts";
import { canonicalConnectorKeyFromManifest } from "../server/connector-key.ts";
import { closeDb, initDb } from "../server/db.ts";
import { withFixtureSourceDeclaration } from "./helpers/fixture-source-declaration.ts";

function claudeCodeManifest(connectorId: string, displayName: string) {
  return withFixtureSourceDeclaration(
    {
      capabilities: { human_interaction: [] },
      connector_id: connectorId,
      display_name: displayName,
      manifest_uri: connectorId.startsWith("http") ? connectorId : "https://registry.pdpp.dev/connectors/claude-code",
      protocol_version: "0.1.0",
      streams: [
        {
          consent_time_field: "ts",
          cursor_field: "ts",
          name: "sessions",
          primary_key: ["id"],
          query: {},
          schema: {
            properties: {
              id: { type: "string" },
              ts: { format: "date-time", type: "string" },
            },
            required: ["id", "ts"],
            type: "object",
          },
          selection: { fields: true, resources: true },
          semantics: "mutable_state",
        },
      ],
      version: "1.0.0",
    },
    { sourceId: connectorId.startsWith("http") ? connectorId : "https://registry.pdpp.dev/connectors/claude-code" }
  );
}

test("registering the registry-URL spelling and the bare key yields one canonical connector row", async () => {
  initDb();
  try {
    const url = claudeCodeManifest("https://registry.pdpp.dev/connectors/claude-code", "Claude Code (URL)");
    const bare = claudeCodeManifest("claude-code", "Claude Code (bare key)");

    // Both manifests resolve to the same canonical short key.
    assert.equal(canonicalConnectorKeyFromManifest(url), "claude-code");
    assert.equal(canonicalConnectorKeyFromManifest(bare), "claude-code");

    await registerConnector(url);
    await registerConnector(bare);

    const ids = await listRegisteredConnectorIds();
    // The picker enumerates exactly these ids: one canonical row, no
    // URL-shaped duplicate.
    assert.deepEqual(
      ids.filter((id: string) => id === "claude-code"),
      ["claude-code"],
      "exactly one canonical claude-code row"
    );
    assert.ok(
      !ids.includes("https://registry.pdpp.dev/connectors/claude-code"),
      "URL-shaped connector id must not survive as a separate row"
    );
  } finally {
    closeDb();
  }
});

test("bare key registered before its registry-URL spelling still collapses to one canonical row", async () => {
  initDb();
  try {
    // Reverse registration order must not produce a duplicate.
    await registerConnector(claudeCodeManifest("claude-code", "Claude Code (bare key)"));
    await registerConnector(claudeCodeManifest("https://registry.pdpp.dev/connectors/claude-code", "Claude Code (URL)"));

    const ids = await listRegisteredConnectorIds();
    assert.deepEqual(
      ids.filter((id: string) => id === "claude-code"),
      ["claude-code"],
      "exactly one canonical claude-code row regardless of registration order"
    );
  } finally {
    closeDb();
  }
});

test("registerConnector accepts connector_key plus manifest_uri manifests", async () => {
  initDb();
  try {
    const manifest = withFixtureSourceDeclaration(
      {
        capabilities: { human_interaction: [] },
        connector_key: "custom-source",
        display_name: "Custom Source",
        manifest_uri: "https://example.test/manifests/custom-source",
        protocol_version: "0.1.0",
        streams: [
          {
            consent_time_field: "updated_at",
            cursor_field: "updated_at",
            name: "items",
            primary_key: ["id"],
            query: {},
            schema: {
              properties: {
                id: { type: "string" },
                updated_at: { format: "date-time", type: "string" },
              },
              required: ["id", "updated_at"],
              type: "object",
            },
            selection: { fields: true, resources: true },
            semantics: "mutable_state",
          },
        ],
        version: "1.0.0",
      },
      { sourceId: "https://example.test/manifests/custom-source" }
    );

    const registeredId = await registerConnector(manifest);
    assert.equal(registeredId, "custom-source");
    assert.deepEqual(await listRegisteredConnectorIds(), ["custom-source"]);

    const storedManifest = await getConnectorManifest("custom-source");
    assert.ok(storedManifest, "registered connector manifest is persisted");
    assert.equal(storedManifest.connector_id, "custom-source");
    assert.equal(storedManifest.connector_key, "custom-source");
    assert.equal(storedManifest.manifest_uri, "https://example.test/manifests/custom-source");
  } finally {
    closeDb();
  }
});

test("registerConnector rejects mismatched connector_key and connector_id", async () => {
  initDb();
  try {
    const mismatched = {
      ...claudeCodeManifest("github", "Mismatched"),
      connector_key: "slack",
    };
    await assert.rejects(() => registerConnector(mismatched), /connector_key must match|connector_id must match/);
  } finally {
    closeDb();
  }
});
