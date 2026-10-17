// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const PAGE_FILE = `${HERE}[connector]/page.tsx`;
const ACTIONS_FILE = `${HERE}[connector]/actions.ts`;
const DANGER_ZONE_FILE = `${HERE}[connector]/connection-danger-zone.tsx`;
const REF_CLIENT_FILE = `${HERE}../lib/ref-client.ts`;

async function read(path: string): Promise<string> {
  return await readFile(path, "utf8");
}

test("the detail route keeps setup-failed identity and renders same-connection recovery", async () => {
  const page = await read(PAGE_FILE);
  assert.match(page, /setupFailed:\s*isSetupFailedSource\(summary\)/);
  assert.match(page, /setupFailed \? <ResumeSetupSection connectionId=\{connectionId\} \/> : null/);
  assert.match(page, /<ConnectionDangerZone[\s\S]*connectionId=\{connectorInstanceId \?\? connectionId\}/);
  assert.match(page, /function ResumeSetupSection[\s\S]*>\s*Resume setup\s*<\/IcButton>/);
});

test("the reference client carries source visibility on scoped connection reads", async () => {
  const client = await read(REF_CLIENT_FILE);
  const start = client.indexOf("if (options.connectionRouteId)");
  const end = client.indexOf("// Unscoped callers always page", start);
  assert.ok(start >= 0 && end > start);
  assert.match(client.slice(start, end), /sources_visibility:\s*options\.sourcesVisibility \? 1 : undefined/);
});

test("resuming setup reactivates only the setup-failed connection then opens its setup status", async () => {
  const actions = await read(ACTIONS_FILE);
  const start = actions.indexOf("export async function resumeSetupConnectionAction");
  assert.ok(start >= 0, "resumeSetupConnectionAction must exist");
  const body = actions.slice(start, actions.indexOf("\nexport async function ", start + 1));
  assert.match(body, /listConnectorSummaries\(\{\s*connectionRouteId:\s*connectionId,\s*sourcesVisibility:\s*true\s*\}\)/);
  assert.match(body, /summary\.connection_id === connectionId && isSetupFailedSource\(summary\)/);
  assert.match(body, /await reactivateConnection\(connectionId\)/);
  assert.match(body, /\/connect\/status\/\$\{encodeURIComponent\(connectionId\)\}/);
});

test("setup-failed details reuse the single-connection danger-zone delete", async () => {
  const [page, dangerZone, actions] = await Promise.all([
    read(PAGE_FILE),
    read(DANGER_ZONE_FILE),
    read(ACTIONS_FILE),
  ]);
  assert.match(page, /<ConnectionDangerZone[\s\S]*connectionId=\{connectorInstanceId \?\? connectionId\}/);
  assert.match(dangerZone, /<DeleteForm activeRunId=\{activeRunId\} connectionId=\{connectionId\} \/>/);
  assert.match(actions, /await deleteConnectionWithRunCancel\(connectionId, cancelRunId, \{ cancelRun, deleteConnection \}\)/);
});
