// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Proves the wiring, not just the composer: a REAL connector child spawned by
 * runConnector receives its own tuning knobs from the server environment and
 * does not receive another connector's knobs. The child writes the PDPP_*
 * keys it sees to a file; the assertions read that file.
 */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { type RuntimeRunConnectorOptions, runConnector } from "../runtime/index.ts";
import { closeDb, initDb } from "../server/db.ts";

function manifest(connectorId: string, runtimeRequirements?: Record<string, unknown>) {
  return {
    connector_id: connectorId,
    display_name: "Tuning Capture",
    protocol_version: "0.1.0",
    ...(runtimeRequirements ? { runtime_requirements: runtimeRequirements } : {}),
    streams: [
      {
        name: "items",
        primary_key: ["id"],
        schema: { properties: { id: { type: "string" } }, required: ["id"], type: "object" },
        semantics: "append_only",
      },
    ],
    version: "1.0.0",
  };
}

/** Spawn a capture connector and return the PDPP_* environment it received. */
async function childTuningEnvironment(
  connectorId: string,
  runManifest: ReturnType<typeof manifest>,
  serverEnv: Record<string, string>
): Promise<Record<string, string>> {
  const tmpDir = mkdtempSync(join(tmpdir(), "pdpp-tuning-env-"));
  const capturePath = join(tmpDir, "env.json");
  const connectorPath = join(tmpDir, "connector.mjs");
  writeFileSync(
    connectorPath,
    `
import { createInterface } from 'node:readline';
import { writeFileSync } from 'node:fs';
const rl = createInterface({ input: process.stdin, terminal: false });
rl.on('line', (line) => {
  if (JSON.parse(line).type !== 'START') return;
  const seen = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.startsWith('PDPP_') && !key.startsWith('PDPP_BROWSER_') && !key.startsWith('PDPP_RUN_') && !key.startsWith('PDPP_CONNECTOR_') && !['PDPP_OWNER_TOKEN', 'PDPP_RS_URL', 'PDPP_REFERENCE_BASE_URL', 'PDPP_STREAMING_REGISTRATION_TOKEN'].includes(key)));
  writeFileSync(${JSON.stringify(capturePath)}, JSON.stringify(seen));
  process.stdout.write(JSON.stringify({ type: 'DONE', status: 'succeeded', records_emitted: 0 }) + '\\n');
  rl.close();
  process.exit(0);
});
`,
    "utf8"
  );
  const prior = Object.fromEntries(Object.keys(serverEnv).map((key) => [key, process.env[key]]));
  Object.assign(process.env, serverEnv);
  initDb(":memory:");
  try {
    const result = (await runConnector({
      admitRunConnection: ({ connectorId: admitted }: { connectorId: string }) =>
        Promise.resolve({ connectorId: admitted, connectorInstanceId: "cin_tuning", ownerSubjectId: "owner-1" }),
      connectorId,
      connectorInstanceId: "cin_tuning",
      connectorPath,
      manifest: runManifest as unknown as RuntimeRunConnectorOptions["manifest"],
      onInteraction: null,
      onProgress: () => undefined,
      ownerSubjectId: "owner-1",
      ownerToken: "test-token",
      persistState: false,
      state: null,
    } as unknown as RuntimeRunConnectorOptions)) as { status: string };
    assert.equal(result.status, "succeeded");
    return JSON.parse(readFileSync(capturePath, "utf8")) as Record<string, string>;
  } finally {
    for (const [key, value] of Object.entries(prior)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    closeDb();
    rmSync(tmpDir, { force: true, recursive: true });
  }
}

const SERVER_ENV = {
  PDPP_CHATGPT_PACING_MIN_INTERVAL_MS: "250",
  PDPP_GMAIL_MAX_ATTACHMENT_BYTES: "1048576",
  PDPP_STRAVA_PAGE_SIZE: "50",
};

test("a real ChatGPT child receives its own undeclared knob and not Gmail's", async () => {
  const connectorId = "https://registry.pdpp.dev/connectors/chatgpt";
  const env = await childTuningEnvironment(connectorId, manifest(connectorId), SERVER_ENV);

  assert.deepEqual(env, { PDPP_CHATGPT_PACING_MIN_INTERVAL_MS: "250" });
});

test("a real child receives a knob its first-party manifest declares", async () => {
  const connectorId = "https://registry.pdpp.dev/connectors/strava";
  const env = await childTuningEnvironment(
    connectorId,
    manifest(connectorId, { tuning_environment: ["PDPP_STRAVA_PAGE_SIZE"] }),
    SERVER_ENV
  );

  assert.deepEqual(env, { PDPP_STRAVA_PAGE_SIZE: "50" });
});

test("a real third-party child receives no declared knob without an operator binding", async () => {
  const connectorId = "https://registry.example.com/connectors/strava";
  const env = await childTuningEnvironment(
    connectorId,
    manifest(connectorId, { tuning_environment: ["PDPP_STRAVA_PAGE_SIZE"] }),
    SERVER_ENV
  );

  assert.deepEqual(env, {});
});
