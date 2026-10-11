// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { type RuntimeRunConnectorOptions, runConnector } from "../runtime/index.ts";
import { validateConnectorManifest } from "../server/connector-manifest-validation.ts";
import { closeDb, initDb } from "../server/db.ts";

const manifest = {
  connector_id: "placement-test",
  protocol_version: "0.1.0",
  streams: [{ name: "items", primary_key: ["id"], schema: { properties: { id: { type: "string" } } } }],
};

// A real child writes its marker before reading START. This proves that a
// placement refusal happens before any connector code executes (CP §4).
async function withConnector(
  fn: (
    run: (declaration: RuntimeRunConnectorOptions["manifest"]) => ReturnType<typeof runConnector>,
    marker: string
  ) => Promise<void>,
  messages: unknown[] = [{ records_emitted: 0, status: "succeeded", type: "DONE" }]
): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "pdpp-placement-"));
  const marker = join(dir, "start.json");
  const connectorPath = join(dir, "connector.cjs");
  initDb(":memory:");
  writeFileSync(
    connectorPath,
    `
    const fs = require('node:fs');
    fs.writeFileSync(${JSON.stringify(marker)}, 'spawned');
    require('node:readline').createInterface({ input: process.stdin }).once('line', line => {
      fs.writeFileSync(${JSON.stringify(marker)}, line);
      for (const msg of ${JSON.stringify(messages)}) console.log(JSON.stringify(msg));
      process.exit(0);
    });
  `
  );
  try {
    await fn(
      (declaration) =>
        runConnector({
          admitRunConnection: async ({ connectorId, connectorInstanceId }) => ({
            connectorId,
            connectorInstanceId: connectorInstanceId ?? "cin_placement",
            ownerSubjectId: "placement-owner",
          }),
          connectorId: "placement-test",
          connectorPath,
          manifest: declaration,
          onProgress: () => undefined,
          ownerSubjectId: "placement-owner",
          ownerToken: "test",
          persistState: false,
          rsUrl: "http://127.0.0.1:1",
        }),
      marker
    );
  } finally {
    closeDb();
    rmSync(dir, { force: true, recursive: true });
  }
}

test("placement refuses BLOB and OBSERVATION with a typed reason before spawn", async () => {
  for (const capability of ["BLOB", "OBSERVATION"]) {
    // biome-ignore lint/performance/noAwaitInLoops: the runtime store uses one process-global database.
    await withConnector(async (run, marker) => {
      await assert.rejects(run({ ...manifest, protocol_capabilities: [capability] }), {
        code: "runtime_capability_mismatch",
        missing: [capability],
      });
      assert.equal(existsSync(marker), false);
    });
  }
});

test("placement refuses unsupported required binding features before spawn", async () => {
  await withConnector(async (run, marker) => {
    await assert.rejects(
      run({
        ...manifest,
        runtime_requirements: {
          bindings: {
            browser: { features: ["page_navigation", "example.com/unsupported_feature"], required: true },
          },
        },
      }),
      {
        code: "runtime_capability_mismatch",
        missing: ["browser"],
        missingFeatures: [{ binding: "browser", features: ["example.com/unsupported_feature"] }],
      }
    );
    assert.equal(existsSync(marker), false);
  });
});

test("extension bindings install; required unsupported extensions refuse before spawn", async () => {
  for (const required of [false, true]) {
    const declaration = { ...manifest, runtime_requirements: { bindings: { "example.com/scanner": { required } } } };
    assert.doesNotThrow(() => validateConnectorManifest(declaration));
    // biome-ignore lint/performance/noAwaitInLoops: the runtime store uses one process-global database.
    await withConnector(async (run, marker) => {
      if (required) {
        await assert.rejects(run(declaration), {
          code: "runtime_capability_mismatch",
          missing: ["example.com/scanner"],
        });
        assert.equal(existsSync(marker), false);
      } else {
        assert.equal((await run(declaration)).status, "succeeded");
        assert.equal(Object.hasOwn(JSON.parse(readFileSync(marker, "utf8")).bindings, "example.com/scanner"), false);
      }
    });
  }
});

test("removed interactive and malformed extension names are rejected even when optional", () => {
  for (const binding of [
    "interactive",
    "scanner",
    "example/scanner",
    "example.com/",
    "example.com/scanner/extra",
    "-example.com/scanner",
  ]) {
    assert.throws(() =>
      validateConnectorManifest({ ...manifest, runtime_requirements: { bindings: { [binding]: { required: false } } } })
    );
  }
});

test("optional unsupported features are omitted and valid catalog feature names still run", async () => {
  await withConnector(async (run, marker) => {
    assert.equal(
      (
        await run({
          ...manifest,
          runtime_requirements: {
            bindings: {
              browser: { features: ["example.com/unsupported_feature"], required: false },
              network: { features: ["same_origin_page_fetch", "host_http_request"], required: true },
            },
          },
        })
      ).status,
      "succeeded"
    );
    const start = JSON.parse(readFileSync(marker, "utf8"));
    assert.equal(Object.hasOwn(start.bindings, "browser"), false);
    assert.equal(Object.hasOwn(start.bindings, "interactive"), false);
    assert.ok(Object.hasOwn(start.bindings, "network"));
  });
});

test("STREAM_EVIDENCE must be declared before its message is accepted", async () => {
  const evidenceManifest = {
    ...manifest,
    streams: [
      ...manifest.streams,
      {
        coverage_strategy: "checkpoint_window",
        name: "co_items",
        primary_key: ["id"],
        schema: { properties: { id: { type: "string" } } },
        state_stream: "items",
      },
    ],
  };
  await withConnector(
    async (run) => {
      await assert.rejects(run(evidenceManifest), {
        failure_reason: "connector_protocol_violation",
        // biome-ignore lint/performance/useTopLevelRegex: localized assertion documents the wire contract.
        message: /undeclared protocol capability: STREAM_EVIDENCE/,
      });
    },
    [
      {
        considered: 0,
        outcomes: { emitted: 0, gapped: 0, unaccounted: 0, unchanged: 0 },
        reference_only: true,
        stream: "co_items",
        type: "STREAM_EVIDENCE",
      },
      { records_emitted: 0, status: "succeeded", type: "DONE" },
    ]
  );
});

test("the runtime rejects removed optional binding names before spawn", async () => {
  await withConnector(async (run, marker) => {
    await assert.rejects(
      run({
        ...manifest,
        runtime_requirements: {
          bindings: {
            interactive: { required: false },
          },
        },
      }),
      { code: "runtime_binding_invalid" }
    );
    assert.equal(existsSync(marker), false);
  });
});

test("all portable browser features and the host_http_request legacy placement remain available", async () => {
  await withConnector(async (run, marker) => {
    assert.equal(
      (
        await run({
          ...manifest,
          protocol_capabilities: ["STREAM_EVIDENCE"],
          runtime_requirements: {
            bindings: {
              browser: {
                features: [
                  "page_navigation",
                  "page_script_evaluation",
                  "page_content_read",
                  "page_condition_wait",
                  "page_input",
                  "cookie_read",
                  "page_response_observation",
                  "host_download_capture",
                  "host_archive_extraction",
                  "host_archive_entry_chunk_read",
                  "host_cookie_jar_request",
                  "host_http_request",
                ],
                required: true,
              },
            },
          },
        })
      ).status,
      "succeeded"
    );
    assert.ok(Object.hasOwn(JSON.parse(readFileSync(marker, "utf8")).bindings, "browser"));
  });
});

test("binding feature declarations must be arrays of unique strings", () => {
  for (const features of ["page_navigation", ["page_navigation", "page_navigation"], [null]]) {
    assert.throws(
      () =>
        validateConnectorManifest({
          ...manifest,
          runtime_requirements: {
            bindings: {
              browser: { features, required: true },
            },
          },
        }),
      // biome-ignore lint/performance/useTopLevelRegex: localized assertion documents the declaration contract.
      /features must be an array of unique non-empty strings/
    );
  }
});
