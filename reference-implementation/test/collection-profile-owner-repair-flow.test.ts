// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Whether the owner is asked to repair a connection after a real failed run.
// A stub connector child runs through runConnector, its real result goes through
// the scheduler's run path, and the test reads the needs-human flag the
// scheduler sets. Collection Profile Section 5.11: a connector's own text and
// flags never authorize a repair prompt. The runtime-owned evidence is a
// cancelled credential interaction.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runConnector } from "../runtime/index.ts";
import { createScheduler } from "../runtime/scheduler.ts";
import type { RunRecord } from "../runtime/scheduler-domain-types.ts";
import { closeDb, getDb, initDb } from "../server/db.ts";
import { createSqliteConnectorInstanceStore } from "../server/stores/connector-instance-store.ts";

const CONNECTOR_ID = "owner-repair-flow-fixture";
const INSTANCE_ID = "cin_owner_repair_flow";
const NOW = "2026-05-20T12:00:00.000Z";

const SCHEDULER_MANIFEST = {
  capabilities: { refresh_policy: { background_safe: true, recommended_mode: "automatic" } },
  streams: [{ name: "items" }],
};

const MANIFEST = {
  capabilities: { human_interaction: ["credentials"], public_listing: { tier: "supported" } },
  connector_id: CONNECTOR_ID,
  display_name: "Owner repair flow",
  protocol_version: "0.1.0",
  runtime_requirements: { bindings: { browser: { required: true }, network: { required: true } } },
  streams: [{ name: "items", primary_key: ["id"] }],
  version: "1.0.0",
};

function withFixture(fn: (dir: string) => Promise<void>): () => Promise<void> {
  return async () => {
    const dir = mkdtempSync(join(tmpdir(), "pdpp-owner-repair-flow-"));
    initDb(join(dir, "pdpp.sqlite"));
    try {
      getDb()
        .prepare("INSERT INTO connectors(connector_id, manifest, created_at) VALUES (?, ?, ?)")
        .run(CONNECTOR_ID, JSON.stringify(MANIFEST), NOW);
      await createSqliteConnectorInstanceStore().upsert({
        connectorId: CONNECTOR_ID,
        connectorInstanceId: INSTANCE_ID,
        createdAt: NOW,
        displayName: "Owner repair flow",
        ownerSubjectId: "owner_local",
        sourceBinding: { device: "personal", kind: "browser_collector" },
        sourceBindingKey: "owner-repair-flow",
        sourceKind: "account",
        status: "active",
        updatedAt: NOW,
      });
      await fn(dir);
    } finally {
      closeDb();
      rmSync(dir, { force: true, recursive: true });
    }
  };
}

function writeConnector(dir: string, body: string): string {
  const connectorPath = join(dir, "connector.mjs");
  writeFileSync(
    connectorPath,
    `
import { createInterface } from 'node:readline';
const rl = createInterface({ input: process.stdin, terminal: false });
const send = (m) => process.stdout.write(JSON.stringify(m) + '\\n');
rl.on('line', (line) => {
  const msg = JSON.parse(line);
${body}
});
`,
    "utf8"
  );
  return connectorPath;
}

interface SchedulerOutcome {
  readonly attempts: number;
  readonly needsHuman: boolean;
  readonly record: RunRecord;
  readonly runStatus: string;
}

// Runs the stub through the real runtime and hands its real result to the
// scheduler, as the managed-run path does. The scheduler decides retry and
// owner repair from that result, so nothing here is a hand-written gap.
async function runThroughScheduler(
  connectorPath: string,
  onInteraction: (message: { request_id: string }) => Promise<Record<string, unknown>>
): Promise<SchedulerOutcome> {
  const needsHuman = new Set<string>();
  const completed: RunRecord[] = [];
  let attempts = 0;
  let runStatus = "";
  const scheduler = createScheduler({
    connectors: [
      {
        connectorId: CONNECTOR_ID,
        connectorInstanceId: INSTANCE_ID,
        connectorPath,
        intervalMs: 25,
        manifest: SCHEDULER_MANIFEST as never,
        maxRetries: 2,
        ownerSubjectId: "owner_local",
        ownerToken: "test-owner-token",
      },
    ],
    isNeedsHuman: (_connectorId, instanceId) => needsHuman.has(instanceId ?? CONNECTOR_ID),
    markNeedsHuman: (_connectorId, instanceId) => needsHuman.add(instanceId ?? CONNECTOR_ID),
    onInteraction: onInteraction as never,
    onRunComplete: (record) => completed.push(record),
    rsUrl: "http://localhost.invalid",
    runManagedConnectorViaController: async () => {
      attempts += 1;
      const result = (await runConnector({
        admitRunConnection: () => ({
          connectorId: CONNECTOR_ID,
          connectorInstanceId: INSTANCE_ID,
          ownerSubjectId: "owner_local",
        }),
        connectorId: CONNECTOR_ID,
        connectorInstanceId: INSTANCE_ID,
        connectorPath,
        manifest: MANIFEST as never,
        onInteraction: onInteraction as never,
        onProgress: () => {
          // Progress events are not asserted here.
        },
        ownerToken: "test-owner-token",
        persistState: false,
        runId: `run_owner_repair_${attempts}`,
        scope: { streams: [{ name: "items" }] },
      } as never)) as unknown as Record<string, unknown>;
      runStatus = String(result.status);
      return result as never;
    },
  });
  try {
    scheduler.start();
    await waitFor(() => completed.length >= 1);
  } finally {
    scheduler.stop();
  }
  const [record] = completed;
  assert.ok(record, "the scheduler recorded the run");
  return { attempts, needsHuman: needsHuman.has(INSTANCE_ID), record, runStatus };
}

async function waitFor(condition: () => boolean, timeoutMs = 10_000): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start >= timeoutMs) {
      throw new Error(`waitFor timed out after ${timeoutMs}ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

test(
  "a lapsed session (owner cancels the credential prompt) flags the connection for owner repair after one attempt",
  withFixture(async (dir) => {
    const connectorPath = writeConnector(
      dir,
      `  if (msg.type === 'START') {
    send({ type: 'INTERACTION', request_id: 'int_1', kind: 'credentials', message: 'Sign in again', timeout_seconds: 30 });
  } else if (msg.type === 'INTERACTION_RESPONSE') {
    send({ type: 'DONE', status: 'failed', records_emitted: 0, error: { message: 'session expired' } });
    rl.close();
    process.exit(1);
  }`
    );
    const outcome = await runThroughScheduler(connectorPath, (message) =>
      Promise.resolve({ request_id: message.request_id, status: "cancelled", type: "INTERACTION_RESPONSE" })
    );
    assert.equal(outcome.runStatus, "failed");
    assert.equal(outcome.attempts, 1, "a lapsed session is not retried");
    assert.equal(outcome.needsHuman, true, "the runtime's own cancelled-interaction record asks the owner to repair");
  })
);

test(
  "KNOWN GAP (#647): a connector-reported 401 with no runtime evidence does not ask the owner to repair",
  withFixture(async (dir) => {
    const connectorPath = writeConnector(
      dir,
      `  if (msg.type === 'START') {
    send({ type: 'DONE', status: 'failed', records_emitted: 0, error: { message: 'apiFetch got 401 on GET /api/items (auth - not retryable)' } });
    rl.close();
    process.exit(1);
  }`
    );
    const outcome = await runThroughScheduler(connectorPath, () => Promise.reject(new Error("no interaction expected")));
    assert.equal(outcome.runStatus, "failed");
    // Pins today's behavior. Collection Profile Section 5.11 makes connector text
    // and flags non-authoritative, and provider_invalidation_proof, the proof that
    // would authorize a prompt here, has no production caller until #647. When
    // #647 lands this assertion must flip to expect a prompt.
    assert.equal(outcome.needsHuman, false, "no owner repair without runtime-owned evidence");
  })
);
