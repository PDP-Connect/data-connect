// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { registerConnector } from "../server/auth.ts";
import { closeDb, getDb, initDb } from "../server/db.ts";
import { projectPairwiseGrant, resolvePairwiseInstanceHandle } from "../server/pairwise-identity.ts";
import { loadPairwiseQueryState } from "../server/pairwise-query-sessions.ts";
import { ingestRecord, queryRecordsAcrossBindings } from "../server/records.ts";
import { createSqliteConnectorInstanceStore } from "../server/stores/connector-instance-store.ts";

const CONNECTOR_ID = "pairwise-recovery-review";
const INSTANCE_ID = "cin_pairwise_recovery_00000001";
const STREAM = "items";
const OWNER_SUBJECT_ID = "owner_recovery_review";
const CLIENT_ID = "client-recovery-review";
const SOURCE_ID = CONNECTOR_ID;
const RECORD_ID = "item-1";

const manifest = {
  capabilities: { human_interaction: [] },
  connector_id: CONNECTOR_ID,
  display_name: "Pairwise Recovery Review",
  manifest_uri: `https://sources.example/${CONNECTOR_ID}`,
  protocol_version: "0.1.0",
  streams: [
    {
      cursor_field: "updated_at",
      name: STREAM,
      primary_key: ["id"],
      schema: {
        properties: {
          id: { type: "string" },
          updated_at: { format: "date-time", type: "string" },
          value: { type: "string" },
        },
        required: ["id", "updated_at", "value"],
        type: "object",
      },
      selection: { fields: true, resources: true },
      semantics: "mutable_state",
    },
  ],
  version: "1.0.0",
};

const rawGrant = {
  client: { client_id: CLIENT_ID },
  grant_id: "grant-recovery-review",
  source: { id: SOURCE_ID },
  streams: [
    {
      fields: ["id", "updated_at", "value"],
      instance_ids: [INSTANCE_ID],
      name: STREAM,
    },
  ],
  subject: { id: OWNER_SUBJECT_ID },
};

function storageTarget() {
  return { connector_id: CONNECTOR_ID, connector_instance_id: INSTANCE_ID };
}

function record(value: string, updatedAt: string) {
  return {
    data: { id: RECORD_ID, updated_at: updatedAt, value },
    emitted_at: updatedAt,
    key: RECORD_ID,
    stream: STREAM,
  };
}

function persistGrant(grant: typeof rawGrant): void {
  getDb()
    .prepare(
      `INSERT INTO grants(grant_id, subject_id, client_id, grant_json, access_mode, issued_at)
       VALUES(?, ?, ?, ?, ?, ?)`
    )
    .run(
      grant.grant_id,
      grant.subject.id,
      grant.client.client_id,
      JSON.stringify(grant),
      "continuous",
      "2026-10-11T12:00:00.000Z"
    );
}

function readGrant(grantId: string) {
  return getDb()
    .prepare(
      "SELECT grant_id, subject_id, client_id, grant_json, access_mode, issued_at FROM grants WHERE grant_id = ?"
    )
    .get(grantId);
}

function singleProjectedInstanceHandle(grant: typeof rawGrant): string {
  const handle = grant.streams[0]?.instance_ids?.[0];
  assert.ok(handle, "projected grant should contain one instance handle");
  return handle;
}

test("SQLite restore preserves its recovery point and exposes later handle rollback", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "pdpp-pairwise-recovery-review-"));
  const dbPath = join(tempDir, "recovery.sqlite");
  const snapshotPath = join(tempDir, "recovery-point.sqlite");
  const priorFlag = process.env.PDPP_EXPERIMENTAL_PAIRWISE_INSTANCE_IDENTITY;
  process.env.PDPP_EXPERIMENTAL_PAIRWISE_INSTANCE_IDENTITY = "1";

  try {
    initDb(dbPath);
    await registerConnector(manifest);
    const now = new Date().toISOString();
    await createSqliteConnectorInstanceStore().upsert({
      connectorId: CONNECTOR_ID,
      connectorInstanceId: INSTANCE_ID,
      createdAt: now,
      displayName: "Recovery fixture account",
      ownerSubjectId: OWNER_SUBJECT_ID,
      sourceBinding: { account: "recovery-review-account" },
      sourceBindingKey: "recovery-review-account",
      sourceKind: "account",
      status: "active",
      updatedAt: now,
    });
    await ingestRecord(storageTarget(), record("at recovery point", "2026-10-11T12:01:00.000Z"), {
      deferIndexes: true,
    });

    const projectedAtRecovery = await projectPairwiseGrant(rawGrant);
    const recoveryHandle = singleProjectedInstanceHandle(projectedAtRecovery);
    persistGrant(rawGrant);
    const recoveryGrantRow = readGrant(rawGrant.grant_id);
    const recoveryRecordRow = getDb()
      .prepare("SELECT record_json FROM records WHERE connector_instance_id = ? AND stream = ? AND record_key = ?")
      .get(INSTANCE_ID, STREAM, RECORD_ID);
    assert.ok(recoveryRecordRow);

    const bindings = [
      {
        connectorId: CONNECTOR_ID,
        connectorInstanceId: INSTANCE_ID,
        instanceId: recoveryHandle,
      },
    ];
    const recoveryPage = await queryRecordsAcrossBindings(
      bindings,
      STREAM,
      rawGrant,
      { changes_since: "beginning", limit: "10" },
      manifest
    );
    assert.deepEqual(
      recoveryPage.data.map(({ id, instance_id, data }) => [instance_id, id, data?.value]),
      [[recoveryHandle, RECORD_ID, "at recovery point"]]
    );
    const checkpoint = (recoveryPage as typeof recoveryPage & { next_changes_since?: string }).next_changes_since;
    assert.ok(checkpoint, "beginning session should issue a durable checkpoint");
    const checkpointState = await loadPairwiseQueryState(checkpoint);
    const checkpointRows = getDb()
      .prepare("SELECT state_json, expires_at, page_expires_at, byte_count FROM pairwise_query_sessions")
      .all();
    assert.equal(checkpointRows.length, 1, "checkpoint state must exist in SQLite at the recovery point");

    closeDb();
    copyFileSync(dbPath, snapshotPath);

    const lateGrant = {
      ...rawGrant,
      grant_id: "grant-issued-after-recovery-point",
      streams: [
        {
          fields: ["id", "updated_at", "value"],
          instance_ids: ["late-internal-account"],
          name: STREAM,
        },
      ],
    };
    initDb(dbPath);
    const lateProjectedBeforeRestore = await projectPairwiseGrant(lateGrant);
    persistGrant(lateGrant);
    await ingestRecord(storageTarget(), record("after recovery point", "2026-10-11T12:02:00.000Z"), {
      deferIndexes: true,
    });
    const postPointChanges = await queryRecordsAcrossBindings(
      bindings,
      STREAM,
      rawGrant,
      { changes_since: checkpoint, limit: "10" },
      manifest
    );
    const afterRecoveryPointCheckpoint = (
      postPointChanges as typeof postPointChanges & {
        next_changes_since?: string;
      }
    ).next_changes_since;
    assert.ok(afterRecoveryPointCheckpoint);
    assert.deepEqual(
      postPointChanges.data.map(({ id, data }) => [id, data?.value]),
      [[RECORD_ID, "after recovery point"]]
    );
    closeDb();

    copyFileSync(snapshotPath, dbPath);
    initDb(dbPath);

    await test("restore retains handles, grant, record, and checkpoint from the backup", async () => {
      assert.deepEqual(await projectPairwiseGrant(rawGrant), projectedAtRecovery);
      assert.deepEqual(readGrant(rawGrant.grant_id), recoveryGrantRow);
      assert.deepEqual(
        getDb()
          .prepare("SELECT record_json FROM records WHERE connector_instance_id = ? AND stream = ? AND record_key = ?")
          .get(INSTANCE_ID, STREAM, RECORD_ID),
        recoveryRecordRow
      );
      assert.deepEqual(
        getDb()
          .prepare("SELECT state_json, expires_at, page_expires_at, byte_count FROM pairwise_query_sessions")
          .all(),
        checkpointRows
      );
      assert.deepEqual(await loadPairwiseQueryState(checkpoint), checkpointState);
      const noChanges = await queryRecordsAcrossBindings(
        bindings,
        STREAM,
        rawGrant,
        { changes_since: checkpoint, limit: "10" },
        manifest
      );
      assert.deepEqual(noChanges.data, []);
      await assert.rejects(
        queryRecordsAcrossBindings(
          bindings,
          STREAM,
          rawGrant,
          { changes_since: afterRecoveryPointCheckpoint, limit: "10" },
          manifest
        ),
        (error: unknown) =>
          typeof error === "object" && error !== null && "code" in error && error.code === "cursor_expired"
      );
    });

    await test("rollback drops a later-issued handle and a later lookup issues a different one", async () => {
      assert.equal(readGrant(lateGrant.grant_id), undefined);
      const lateProjectedAfterRestore = await projectPairwiseGrant(lateGrant);
      const handleBeforeRestore = singleProjectedInstanceHandle(lateProjectedBeforeRestore);
      const handleAfterRestore = singleProjectedInstanceHandle(lateProjectedAfterRestore);
      assert.notEqual(handleAfterRestore, handleBeforeRestore);
      assert.equal(
        await resolvePairwiseInstanceHandle({
          clientId: CLIENT_ID,
          handle: handleBeforeRestore,
          sourceId: SOURCE_ID,
          subjectId: OWNER_SUBJECT_ID,
        }),
        null
      );
      assert.equal(
        await resolvePairwiseInstanceHandle({
          clientId: CLIENT_ID,
          handle: handleAfterRestore,
          sourceId: SOURCE_ID,
          subjectId: OWNER_SUBJECT_ID,
        }),
        "late-internal-account"
      );
    });
  } finally {
    closeDb();
    if (priorFlag === undefined) {
      delete process.env.PDPP_EXPERIMENTAL_PAIRWISE_INSTANCE_IDENTITY;
    } else {
      process.env.PDPP_EXPERIMENTAL_PAIRWISE_INSTANCE_IDENTITY = priorFlag;
    }
    rmSync(tempDir, { force: true, recursive: true });
  }
});
