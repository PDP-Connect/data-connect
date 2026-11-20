// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { getConnectorManifest, registerConnector } from "../server/auth.ts";
import { closeDb, getDb, initDb } from "../server/db.ts";

const NOW = "2026-05-20T12:00:00.000Z";
const CLAUDE_CANONICAL_ID = "https://registry.pdpp.dev/connectors/claude-code";

function withTmpDb(fn: () => Promise<void>): () => Promise<void> {
  return async () => {
    const dir = mkdtempSync(join(tmpdir(), "pdpp-retired-id-lookup-"));
    initDb(join(dir, "pdpp.sqlite"));
    try {
      await fn();
    } finally {
      closeDb();
      rmSync(dir, { force: true, recursive: true });
    }
  };
}

function validManifest(connectorId: string) {
  return {
    connector_id: connectorId,
    display_name: "Claude Code",
    manifest_uri: "https://registry.pdpp.dev/connectors/claude-code",
    protocol_version: "0.1.0",
    streams: [
      {
        consent_time_field: "timestamp",
        cursor_field: "timestamp",
        name: "messages",
        primary_key: ["id"],
        schema: {
          properties: {
            id: { type: "string" },
            text: { type: "string" },
            timestamp: { format: "date-time", type: "string" },
          },
          required: ["id", "timestamp"],
          type: "object",
        },
        selection: { fields: true, resources: true },
        semantics: "append_only",
      },
    ],
    version: "0.3.0",
  };
}

function insertStaleManifest(connectorId: string): void {
  getDb()
    .prepare("INSERT INTO connectors(connector_id, manifest, created_at) VALUES (?, ?, ?)")
    .run(
      connectorId,
      JSON.stringify({
        connector_id: connectorId,
        display_name: "stale local collector placeholder",
        streams: [],
      }),
      NOW
    );
}

const RETIRED_TO_CURRENT = [
  ["apple_photos", "apple-photos"],
  ["claude_code", "claude-code"],
  ["google_messages", "google-messages"],
  ["google_takeout", "google-takeout"],
] as const;

// The server no longer rewrites a retired underscore id to its manifest key.
// A one-time data migration renames stored rows (retired-connector-id-migration
// tests); after it, lookup by the old id finds nothing.
for (const [retiredId, currentId] of RETIRED_TO_CURRENT) {
  test(
    `retired id ${retiredId} no longer resolves a manifest; ${currentId} does`,
    withTmpDb(async () => {
      await registerConnector(validManifest(`https://registry.pdpp.dev/connectors/${currentId}`));

      assert.equal(await getConnectorManifest(retiredId), null, `${retiredId} must not read ${currentId}'s manifest`);

      const manifest = await getConnectorManifest(currentId);
      assert.ok(manifest, `${currentId} manifest exists`);
      assert.equal(manifest.connector_id, currentId);
      assert.deepEqual(
        (manifest.streams ?? []).map((stream) => stream.name),
        ["messages"]
      );
    })
  );
}

test(
  "a stale row stored under a retired id does not borrow the current key's manifest",
  withTmpDb(async () => {
    await registerConnector(validManifest(CLAUDE_CANONICAL_ID));
    insertStaleManifest("claude_code");

    await assert.rejects(
      () => getConnectorManifest("claude_code"),
      // biome-ignore lint/performance/useTopLevelRegex: test assertion patterns remain colocated with the assertion they explain.
      /Connector manifest for claude_code is malformed or no longer valid/
    );
    const manifest = await getConnectorManifest("claude-code");
    assert.equal(manifest?.display_name, "Claude Code");
  })
);

test(
  "malformed connector manifests fail closed",
  withTmpDb(async () => {
    insertStaleManifest("unknown_legacy_local");

    await assert.rejects(
      () => getConnectorManifest("unknown_legacy_local"),
      // biome-ignore lint/performance/useTopLevelRegex: test assertion patterns remain colocated with the assertion they explain.
      /Connector manifest for unknown_legacy_local is malformed or no longer valid/
    );
  })
);
