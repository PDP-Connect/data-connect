// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { reconcileDirtyConnectorSummaryEvidence } from "../server/connector-summary-read-model.ts";
import { closeDb, getDb, initDb } from "../server/db.ts";
import { buildStoredCollectionScope, COLLECTION_SCOPE_STATE_KEY } from "../server/local-collection-scope.ts";
import { getConnectorSummaryForRoute, listConnectorSummaries } from "../server/ref-control.ts";
import { createSqliteConnectorInstanceStore } from "../server/stores/connector-instance-store.ts";
import { getDefaultDeviceExporterStore } from "../server/stores/device-exporter-store.ts";
import { commitTerminalRun } from "../server/stores/terminal-run-commit-store.ts";

const connectorId = "claude-code";
const connectorInstanceId = "cin_terminal_coverage";
const deviceId = "dev_terminal_coverage";
const sourceInstanceId = "src_terminal_coverage";
const ownerSubjectId = "owner_local";

async function withLocalConnection(run: () => Promise<void>): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), "pdpp-terminal-coverage-projection-"));
  initDb(join(directory, "pdpp.sqlite"));
  try {
    const now = new Date().toISOString();
    getDb().prepare("INSERT INTO connectors(connector_id, manifest, created_at) VALUES (?, ?, ?)").run(
      connectorId,
      JSON.stringify({
        capabilities: { public_listing: { tier: "supported" } },
        connector_id: connectorId,
        display_name: "Terminal Coverage Fixture",
        protocol_version: "0.1.0",
        streams: [
          { coverage_stores: ["projects"], coverage_strategy: "checkpoint_window", name: "sessions", primary_key: ["id"] },
          { coverage_stores: ["derived_messages"], coverage_strategy: "checkpoint_window", name: "messages", primary_key: ["id"] },
        ],
        version: "1.0.0",
      }),
      now
    );
    await createSqliteConnectorInstanceStore().upsert({
      connectorId,
      connectorInstanceId,
      createdAt: now,
      displayName: "laptop",
      ownerSubjectId,
      sourceBinding: { device: "laptop", kind: "local_device" },
      sourceBindingKey: "laptop",
      sourceKind: "local_device",
      status: "active",
      updatedAt: now,
    });
    const store = getDefaultDeviceExporterStore();
    await store.createDevice({ createdAt: now, deviceId, displayName: "laptop", ownerSubjectId, status: "active", updatedAt: now });
    await store.upsertSourceInstance({
      connectorId,
      connectorInstanceId,
      createdAt: now,
      deviceId,
      displayName: "laptop collector",
      localBindingId: "laptop",
      sourceInstanceId,
      status: "active",
      updatedAt: now,
    });
    await store.markSourceInstanceHeartbeat(deviceId, sourceInstanceId, {
      lastError: null,
      outboxDiagnostics: { dead_letter: 0, pending: 0, stale_leases: 0, succeeded: 1, total: 1 },
      receivedAt: now,
      recordsPending: 0,
      status: "healthy",
    });
    await run();
  } finally {
    closeDb();
    rmSync(directory, { force: true, recursive: true });
  }
}

async function projectedCoverage() {
  await reconcileDirtyConnectorSummaryEvidence(null);
  const summary = (await listConnectorSummaries()).find((row) => row.connector_instance_id === connectorInstanceId);
  assert.ok(summary);
  return {
    axis: summary.connection_health.axes.coverage,
    conditions: Object.fromEntries(summary.collection_report.map((entry) => [entry.stream, entry.coverage_condition])),
  };
}

async function seedTerminalCoverage(
  status: "collected" | "partial" | "failed",
  malformed = false,
  version: 1 | 2 = 2,
  runId = "run_terminal_coverage"
): Promise<void> {
  const normalizedFacts = version === 1
    ? ["sessions", "messages"].map((stream) => ({ coverage_statuses: ["unaccounted"], stream }))
    : [
        {
          checkpoint: "committed", collected: 0, considered: null, covered: null,
          coverage_statuses: ["collected"], pending_detail_gaps: 0, scoped: true, skipped: null,
          stores: [{ store: malformed ? "unknown_store" : "projects", status: "collected" }], stream: "sessions",
        },
        {
          checkpoint: "committed", collected: 0, considered: null, covered: null,
          coverage_statuses: [status], pending_detail_gaps: status === "collected" ? 0 : 1,
          scoped: true, skipped: null,
          stores: [{ store: "derived_messages", status }], stream: "messages",
        },
      ];
  await commitTerminalRun({
    collectionBoundary: "unscoped",
    commitId: `commit_${runId}`,
    connectorId,
    connectorInstanceId,
    deviceId,
    envelopeHash: "test-envelope-hash",
    normalizedFacts,
    runId,
    sourceInstanceId,
    stateDelta: {},
    version,
  });
}

test("local-device v2 terminal coverage projects per-stream proof; absent proof stays unknown", async () => {
  await withLocalConnection(async () => {
    assert.equal((await projectedCoverage()).axis, "unknown");
    await seedTerminalCoverage("collected");
    const result = await projectedCoverage();
    assert.equal(result.axis, "complete");
    assert.equal(result.conditions.sessions, "complete");
    assert.equal(result.conditions.messages, "complete");
    const detail = await getConnectorSummaryForRoute(connectorInstanceId);
    assert.ok(detail && "connection_health" in detail);
    assert.equal(detail.connection_health.axes.coverage, "complete", "singleton reader agrees with page projection");
  });
});

for (const status of ["partial", "failed"] as const) {
  test(`local-device v2 ${status} verdict never projects covered`, async () => {
    await withLocalConnection(async () => {
      await seedTerminalCoverage(status);
      const result = await projectedCoverage();
      assert.notEqual(result.axis, "complete");
      assert.equal(result.conditions.messages, status === "partial" ? "partial" : "gaps");
    });
  });
}

test("malformed persisted v2 store inventory never projects covered", async () => {
  await withLocalConnection(async () => {
    await seedTerminalCoverage("collected", true);
    assert.notEqual((await projectedCoverage()).axis, "complete");
  });
});

test("legacy terminal commit without v2 proof stays unknown", async () => {
  await withLocalConnection(async () => {
    await seedTerminalCoverage("collected", false, 1);
    assert.equal((await projectedCoverage()).axis, "unknown");
  });
});

test("a newer successful run without typed proof replaces an earlier covered verdict", async () => {
  await withLocalConnection(async () => {
    await seedTerminalCoverage("collected");
    assert.equal((await projectedCoverage()).axis, "complete");
    const runId = "run_terminal_without_coverage";
    await seedTerminalCoverage("collected", false, 1, runId);
    const later = new Date(Date.now() + 60_000).toISOString();
    getDb().prepare("UPDATE run_history SET completed_at = ? WHERE run_id = ?").run(later, runId);
    assert.equal((await projectedCoverage()).axis, "unknown");
  });
});

test("selected-stream v2 proof cannot cover omitted manifest streams", async () => {
  await withLocalConnection(async () => {
    await seedTerminalCoverage("collected");
    const row = getDb().prepare("SELECT facts_json FROM run_history WHERE run_id = ?").get("run_terminal_coverage") as { facts_json: string };
    const facts = JSON.parse(row.facts_json) as { collection_facts: { streams: unknown[] } };
    facts.collection_facts.streams = facts.collection_facts.streams.slice(0, 1);
    getDb().prepare("UPDATE run_history SET facts_json = ? WHERE run_id = ?")
      .run(JSON.stringify(facts), "run_terminal_coverage");
    assert.equal((await projectedCoverage()).axis, "unknown");
  });
});

test("v2 terminal proof for an old collection scope cannot cover the current scope", async () => {
  await withLocalConnection(async () => {
    await seedTerminalCoverage("collected");
    const now = new Date().toISOString();
    getDb().prepare(
      "INSERT INTO connector_state(connector_id, connector_instance_id, stream, state_json, updated_at) VALUES (?, ?, ?, ?, ?)"
    ).run(
      connectorId,
      connectorInstanceId,
      COLLECTION_SCOPE_STATE_KEY,
      JSON.stringify(buildStoredCollectionScope({ since: "2026-01-01T00:00:00.000Z" }, now)),
      now
    );
    assert.equal((await projectedCoverage()).axis, "unknown");
  });
});

test("a newer failed run cannot retain an earlier v2 covered verdict", async () => {
  await withLocalConnection(async () => {
    await seedTerminalCoverage("collected");
    assert.equal((await projectedCoverage()).axis, "complete");
    const later = new Date(Date.now() + 60_000).toISOString();
    getDb().prepare(
      `INSERT INTO run_history (
         connector_instance_id, connector_id, source_json, status, scheduler_managed,
         known_gaps_json, run_id, started_at, completed_at, attempt, facts_json
       ) VALUES (?, ?, '{}', 'failed', 0, '[]', ?, ?, ?, 1, '{}')`
    ).run(connectorInstanceId, connectorId, "run_terminal_coverage_failed", later, later);
    assert.equal((await projectedCoverage()).axis, "unknown");
  });
});
