// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { normalizeTerminalCoverageFacts } from "../operations/local-device-terminal-collection.ts";
import { reconcileDirtyConnectorSummaryEvidence } from "../server/connector-summary-read-model.ts";
import { closeDb, getDb, initDb } from "../server/db.ts";
import { fingerprintDeviceAttemptManifest } from "../server/device-ingest-attempt-context.ts";
import { buildStoredCollectionScope, COLLECTION_SCOPE_STATE_KEY } from "../server/local-collection-scope.ts";
import { readLocalCollectorArtifactDigest, readLocalCollectorRelease } from "../server/local-collector-profiles.ts";
import { getConnectorSummaryForRoute, listConnectorSummaries } from "../server/ref-control.ts";
import { createSqliteConnectorInstanceStore } from "../server/stores/connector-instance-store.ts";
import { getDefaultDeviceExporterStore } from "../server/stores/device-exporter-store.ts";
import { commitTerminalRun } from "../server/stores/terminal-run-commit-store.ts";

const connectorId = "claude-code";
const connectorInstanceId = "cin_terminal_coverage";
const deviceId = "dev_terminal_coverage";
const sourceInstanceId = "src_terminal_coverage";
const ownerSubjectId = "owner_local";

async function withLocalConnection(run: () => Promise<void>, sourceConnectorId = connectorId): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), "pdpp-terminal-coverage-projection-"));
  initDb(join(directory, "pdpp.sqlite"));
  try {
    const now = new Date().toISOString();
    getDb()
      .prepare("INSERT INTO connectors(connector_id, manifest, created_at) VALUES (?, ?, ?)")
      .run(
        sourceConnectorId,
        JSON.stringify({
          capabilities: { public_listing: { tier: "supported" } },
          connector_id: sourceConnectorId,
          display_name: "Terminal Coverage Fixture",
          protocol_version: "0.1.0",
          streams: [
            {
              coverage_stores: ["projects"],
              coverage_strategy: "checkpoint_window",
              name: "sessions",
              primary_key: ["id"],
            },
            {
              coverage_stores: ["derived_messages"],
              coverage_strategy: "checkpoint_window",
              name: "messages",
              primary_key: ["id"],
            },
          ],
          version: "1.0.0",
        }),
        now
      );
    await createSqliteConnectorInstanceStore().upsert({
      connectorId: sourceConnectorId,
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
    await store.createDevice({
      createdAt: now,
      deviceId,
      displayName: "laptop",
      ownerSubjectId,
      status: "active",
      updatedAt: now,
    });
    await store.upsertSourceInstance({
      connectorId: sourceConnectorId,
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
    reason: summary.connection_health.conditions.find((condition) => condition.type === "SourceCoverageComplete")
      ?.reason,
  };
}

async function seedTerminalCoverage(
  status: "collected" | "partial" | "failed" | "unavailable",
  malformed = false,
  version: 1 | 2 = 2,
  accountingOverrides: Record<string, unknown> = {},
  artifactDigest = readLocalCollectorArtifactDigest(connectorId),
  sourceConnectorId = connectorId,
  claimedManifestFingerprint?: string
): Promise<void> {
  const manifest = JSON.parse(
    (
      getDb().prepare("SELECT manifest FROM connectors WHERE connector_id = ?").get(sourceConnectorId) as {
        manifest: string;
      }
    ).manifest
  );
  const registeredRelease = readLocalCollectorRelease(sourceConnectorId);
  const bindings = {
    artifact_digest: artifactDigest,
    binding_generation: 0,
    manifest_fingerprint:
      claimedManifestFingerprint ??
      (registeredRelease
        ? fingerprintDeviceAttemptManifest(registeredRelease.manifest)
        : fingerprintDeviceAttemptManifest(manifest)),
    runtime_accounting: {
      checkpoint_eligible: true,
      detail_complete: true,
      durable_admission: true,
      outstanding_debt: 0,
      stream_evidence_consistent: true,
      ...accountingOverrides,
    },
    server_artifact_digest: readLocalCollectorArtifactDigest(sourceConnectorId),
  };
  await commitTerminalRun({
    collectionBoundary: "unscoped",
    commitId: "commit_terminal_coverage",
    connectorId: sourceConnectorId,
    connectorInstanceId,
    deviceId,
    envelopeHash: "test-envelope-hash",
    normalizedFacts: [
      {
        ...bindings,
        checkpoint: "committed",
        collected: 0,
        considered: null,
        coverage_statuses: ["collected"],
        covered: null,
        pending_detail_gaps: 0,
        scoped: true,
        skipped: null,
        stores: [{ status: "collected", store: malformed ? "unknown_store" : "projects" }],
        stream: "sessions",
      },
      {
        ...bindings,
        checkpoint: "committed",
        collected: 0,
        considered: null,
        coverage_statuses: [status],
        covered: null,
        pending_detail_gaps: status === "collected" ? 0 : 1,
        scoped: true,
        skipped: null,
        stores: [{ status, store: "derived_messages" }],
        stream: "messages",
      },
    ],
    runId: "run_terminal_coverage",
    sourceInstanceId,
    stateDelta: {},
    version,
  });
}

test("registered release fingerprint survives catalog connector-key normalization", async () => {
  const release = readLocalCollectorRelease(connectorId);
  assert.ok(release, "the reference server must have a verified local-collector release pin");
  await withLocalConnection(async () => {
    await seedTerminalCoverage(
      "collected",
      false,
      2,
      {},
      release.artifactDigest,
      connectorId,
      fingerprintDeviceAttemptManifest(release.manifest)
    );
    assert.equal((await projectedCoverage()).axis, "complete");
  });
});

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

test("unchanged manifest with a different artifact digest projects unknown on list and detail", async () => {
  await withLocalConnection(async () => {
    await seedTerminalCoverage("collected", false, 2, {}, `sha256:${"b".repeat(64)}`);
    const list = await projectedCoverage();
    assert.equal(list.axis, "unknown");
    assert.equal(list.reason, "coverage_unknown_artifact_mismatch");
    const detail = await getConnectorSummaryForRoute(connectorInstanceId);
    assert.ok(detail && "connection_health" in detail);
    assert.equal(detail.connection_health.axes.coverage, "unknown");
    assert.equal(
      detail.connection_health.conditions.find((condition) => condition.type === "SourceCoverageComplete")?.reason,
      "coverage_unknown_artifact_mismatch"
    );
  });
});

test("a local source without a server pin projects unknown with an explicit reason", async () => {
  await withLocalConnection(async () => {
    await seedTerminalCoverage("collected", false, 2, {}, `sha256:${"b".repeat(64)}`, "gmail");
    const list = await projectedCoverage();
    assert.equal(list.axis, "unknown");
    assert.equal(list.reason, "coverage_unknown_artifact_unpinned");
    const detail = await getConnectorSummaryForRoute(connectorInstanceId);
    assert.ok(detail && "connection_health" in detail);
    assert.equal(detail.connection_health.axes.coverage, "unknown");
    assert.equal(
      detail.connection_health.conditions.find((condition) => condition.type === "SourceCoverageComplete")?.reason,
      "coverage_unknown_artifact_unpinned"
    );
  }, "gmail");
});

test("an unavailable store verdict never projects complete on list or detail", async () => {
  await withLocalConnection(async () => {
    await seedTerminalCoverage("unavailable");
    const list = await projectedCoverage();
    assert.notEqual(list.axis, "complete");
    const detail = await getConnectorSummaryForRoute(connectorInstanceId);
    assert.ok(detail && "connection_health" in detail);
    assert.notEqual(detail.connection_health.axes.coverage, "complete");
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

test("selected-stream v2 proof cannot cover omitted manifest streams", async () => {
  await withLocalConnection(async () => {
    await seedTerminalCoverage("collected");
    const row = getDb().prepare("SELECT facts_json FROM run_history WHERE run_id = ?").get("run_terminal_coverage") as {
      facts_json: string;
    };
    const facts = JSON.parse(row.facts_json) as { collection_facts: { streams: unknown[] } };
    facts.collection_facts.streams = facts.collection_facts.streams.slice(0, 1);
    getDb()
      .prepare("UPDATE run_history SET facts_json = ? WHERE run_id = ?")
      .run(JSON.stringify(facts), "run_terminal_coverage");
    const selected = await projectedCoverage();
    assert.equal(selected.axis, "unknown");
    assert.equal(selected.conditions.sessions, "complete");
    assert.equal(selected.conditions.messages, "unknown");
  });
});

test("v2 terminal proof for an old collection scope cannot cover the current scope", async () => {
  await withLocalConnection(async () => {
    await seedTerminalCoverage("collected");
    const now = new Date().toISOString();
    getDb()
      .prepare(
        "INSERT INTO connector_state(connector_id, connector_instance_id, stream, state_json, updated_at) VALUES (?, ?, ?, ?, ?)"
      )
      .run(
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
    getDb()
      .prepare(
        `INSERT INTO run_history (
         connector_instance_id, connector_id, source_json, status, scheduler_managed,
         known_gaps_json, run_id, started_at, completed_at, attempt, facts_json
       ) VALUES (?, ?, '{}', 'failed', 0, '[]', ?, ?, ?, 1, '{}')`
      )
      .run(connectorInstanceId, connectorId, "run_terminal_coverage_failed", later, later);
    assert.equal((await projectedCoverage()).axis, "unknown");
  });
});

for (const includeState of [false, true]) {
  test(`successful empty v2 terminal replacement retires earlier proof ${includeState ? "with" : "without"} state`, async () => {
    await withLocalConnection(async () => {
      await seedTerminalCoverage("collected");
      assert.equal((await projectedCoverage()).axis, "complete");
      const manifestRow = getDb().prepare("SELECT manifest FROM connectors WHERE connector_id = ?").get(connectorId) as {
        manifest: string;
      };
      const manifest = JSON.parse(manifestRow.manifest) as unknown;
      const artifactDigest = readLocalCollectorArtifactDigest(connectorId);
      const unknownFacts = normalizeTerminalCoverageFacts([], manifest, "unscoped", {
        allowSubset: true,
        bindingGeneration: 0,
        expectedArtifactDigest: artifactDigest,
        validateServerArtifactDigest: true,
      });
      assert.ok(unknownFacts, "the empty successful result must expand to explicit unknown inventory");
      await commitTerminalRun({
        collectionBoundary: "unscoped",
        commitId: `commit_terminal_coverage_omission_${includeState}`,
        connectorId,
        connectorInstanceId,
        deviceId,
        envelopeHash: `empty-terminal-envelope-${includeState}`,
        normalizedFacts: unknownFacts,
        runId: `run_terminal_coverage_omission_${includeState}`,
        sourceInstanceId,
        stateDelta: includeState ? { sessions: { cursor: "later" } } : {},
        version: 2,
      });
      assert.equal((await projectedCoverage()).axis, "unknown");
      const detail = await getConnectorSummaryForRoute(connectorInstanceId);
      assert.ok(detail && "connection_health" in detail);
      assert.equal(detail.connection_health.axes.coverage, "unknown");
    });
  });
}

test("catalog obligation changes invalidate proof when the binding generation advances", async () => {
  await withLocalConnection(async () => {
    await seedTerminalCoverage("collected");
    assert.equal((await projectedCoverage()).axis, "complete");
    const row = getDb().prepare("SELECT manifest FROM connectors WHERE connector_id = ?").get(connectorId) as {
      manifest: string;
    };
    const manifest = JSON.parse(row.manifest);
    manifest.version = "2.0.0";
    manifest.streams[0].description = "Now includes content and attachments";
    getDb()
      .prepare("UPDATE connectors SET manifest = ? WHERE connector_id = ?")
      .run(JSON.stringify(manifest), connectorId);
    getDb()
      .prepare("UPDATE connector_instances SET manifest_generation = manifest_generation + 1 WHERE connector_instance_id = ?")
      .run(connectorInstanceId);
    assert.equal((await projectedCoverage()).axis, "unknown");
  });
});

test("persisted terminal coverage cannot cross a source binding generation", async () => {
  await withLocalConnection(async () => {
    await seedTerminalCoverage("collected");
    assert.equal((await projectedCoverage()).axis, "complete");
    getDb()
      .prepare(
        "UPDATE connector_instances SET manifest_generation = manifest_generation + 1 WHERE connector_instance_id = ?"
      )
      .run(connectorInstanceId);
    assert.equal((await projectedCoverage()).axis, "unknown");
  });
});

for (const [field, value] of Object.entries({
  checkpoint_eligible: false,
  detail_complete: false,
  durable_admission: false,
  outstanding_debt: 1,
  stream_evidence_consistent: false,
})) {
  test(`runtime ${field} contradiction prevents both owner projections claiming complete`, async () => {
    await withLocalConnection(async () => {
      await seedTerminalCoverage("collected", false, 2, { [field]: value });
      const result = await projectedCoverage();
      assert.notEqual(result.axis, "complete");
      assert.notEqual(result.conditions.messages, "complete");
      const detail = await getConnectorSummaryForRoute(connectorInstanceId);
      assert.ok(detail && "connection_health" in detail);
      assert.notEqual(detail.connection_health.axes.coverage, "complete");
    });
  });
}
