// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Registration applies the tuning-namespace rule with the connectors that are
 * installed at that moment: no connector list is built into the server.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { mock } from "node:test";
import { getConnectorManifest, registerConnector } from "../server/auth.ts";
import { closeDb, initDb } from "../server/db.ts";

function withTmpDb(fn: () => Promise<void>): () => Promise<void> {
  return async () => {
    const dir = mkdtempSync(join(tmpdir(), "pdpp-tuning-registration-"));
    initDb(join(dir, "pdpp.sqlite"));
    try {
      await fn();
    } finally {
      mock.restoreAll();
      closeDb();
      rmSync(dir, { force: true, recursive: true });
    }
  };
}

function manifest(connectorKey: string, tuningEnvironment: readonly string[]) {
  return {
    connector_key: connectorKey,
    display_name: connectorKey,
    protocol_version: "0.1.0",
    runtime_requirements: { tuning_environment: [...tuningEnvironment] },
    streams: [
      {
        name: "items",
        primary_key: ["id"],
        schema: {
          properties: { id: { type: "string" } },
          required: ["id"],
          type: "object",
        },
        selection: { fields: true, resources: true },
        semantics: "append_only",
      },
    ],
    version: "1.0.0",
  };
}

const register = (value: ReturnType<typeof manifest>) =>
  registerConnector(value as unknown as Record<string, unknown>, {
    skipDerivedRepair: true,
  });

test(
  "registration refuses a connector that declares a variable the server reads",
  withTmpDb(async () => {
    await assert.rejects(
      register(manifest("database", ["PDPP_DATABASE_URL"])),
      /PDPP_DATABASE_URL is a server-owned environment variable/
    );
    assert.equal(await getConnectorManifest("database"), null);
    await register(manifest("database", ["PDPP_DATABASE_PAGE_SIZE"]));
  })
);

test(
  "registration refuses a key inside the longer namespace of an installed connector",
  withTmpDb(async () => {
    await register(manifest("google-maps-data-portability", ["PDPP_GOOGLE_MAPS_DATA_PORTABILITY_PAGE_SIZE"]));
    await assert.rejects(
      register(manifest("google-maps", ["PDPP_GOOGLE_MAPS_DATA_PORTABILITY_PAGE_SIZE"])),
      /belongs to the installed connector google-maps-data-portability/
    );
    await register(manifest("google-maps", ["PDPP_GOOGLE_MAPS_PAGE_SIZE"]));
  })
);

test(
  "installing the longer connector later keeps the shorter one readable and warns about the moved key",
  withTmpDb(async () => {
    const warn = mock.method(console, "warn", () => undefined);
    await register(
      manifest("google-maps", ["PDPP_GOOGLE_MAPS_PAGE_SIZE", "PDPP_GOOGLE_MAPS_DATA_PORTABILITY_PAGE_SIZE"])
    );
    assert.equal(warn.mock.callCount(), 0);

    await register(manifest("google-maps-data-portability", ["PDPP_GOOGLE_MAPS_DATA_PORTABILITY_PAGE_SIZE"]));

    const messages = warn.mock.calls.map((call) => String(call.arguments[0]));
    assert.equal(messages.length, 1);
    assert.match(messages[0] ?? "", /google-maps declares PDPP_GOOGLE_MAPS_DATA_PORTABILITY_PAGE_SIZE/);
    assert.match(messages[0] ?? "", /google-maps-data-portability/);
    // The stored shorter manifest still reads: only registration judges nesting.
    assert.ok(await getConnectorManifest("google-maps"));
  })
);
