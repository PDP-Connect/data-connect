// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { registerConnector } from "../server/auth.ts";
import { getPairwiseHandle, resolvePairwiseInstanceHandle } from "../server/pairwise-identity.ts";
import { closePostgresStorage, initPostgresStorage } from "../server/postgres-storage.ts";
import { deleteRecord, ingestRecord, queryRecordsAcrossBindings } from "../server/records.ts";
import { createPostgresConnectorInstanceStore } from "../server/stores/connector-instance-store.ts";
import { withTemporaryPostgresDatabase } from "./helpers/postgres-temp-database.ts";

test("PostgreSQL persists pairwise handles and globally pages duplicate record keys and tombstones", {
  skip: process.env.PDPP_TEST_POSTGRES_URL ? false : "PDPP_TEST_POSTGRES_URL unset",
}, async () => {
  process.env.PDPP_EXPERIMENTAL_PAIRWISE_INSTANCE_IDENTITY = "1";
  try {
    await withTemporaryPostgresDatabase(
      {
        closeConnections: closePostgresStorage,
        connectionString: process.env.PDPP_TEST_POSTGRES_URL!,
        databaseName: `pdpp_pairwise_storage_${randomUUID().replaceAll("-", "")}`,
        templateName: null,
      },
      async (databaseUrl) => {
        await initPostgresStorage({ backend: "postgres", databaseUrl });
        const scope = {
          clientId: "client_a",
          sourceId: "pairwise-pg",
          subjectId: "owner_local",
        };
        const handles = await Promise.all(
          Array.from({ length: 10 }, () =>
            getPairwiseHandle({
              ...scope,
              internalId: "account_a",
              kind: "instance",
            })
          )
        );
        assert.equal(new Set(handles).size, 1);
        await closePostgresStorage();
        await initPostgresStorage({ backend: "postgres", databaseUrl });
        assert.equal(
          await getPairwiseHandle({
            ...scope,
            internalId: "account_a",
            kind: "instance",
          }),
          handles[0]
        );
        assert.equal(
          await resolvePairwiseInstanceHandle({
            ...scope,
            handle: handles[0]!,
          }),
          "account_a"
        );
        const manifest = {
          capabilities: { human_interaction: [] },
          connector_id: "pairwise-pg",
          display_name: "PG",
          manifest_uri: "https://sources.example/pairwise-pg",
          protocol_version: "0.1.0",
          streams: [
            {
              cursor_field: "rank",
              name: "items",
              primary_key: ["id"],
              schema: {
                properties: {
                  id: { type: "string" },
                  rank: { type: "integer" },
                },
                required: ["id"],
                type: "object",
              },
              selection: { fields: true, resources: true },
              semantics: "mutable_state",
            },
          ],
          version: "1.0.0",
        };
        await registerConnector(manifest);
        const store = createPostgresConnectorInstanceStore();
        const now = new Date().toISOString();
        const bindings = [];
        for (const [internalId, instanceId, rank] of [
          ["account_a", "inst_z", 1],
          ["account_b", "inst_a", 2],
        ] as const) {
          await store.upsert({
            connectorId: "pairwise-pg",
            connectorInstanceId: internalId,
            createdAt: now,
            displayName: internalId,
            ownerSubjectId: "owner_local",
            sourceBinding: { account: internalId },
            sourceBindingKey: internalId,
            sourceKind: "account",
            status: "active",
            updatedAt: now,
          });
          await ingestRecord(
            { connector_id: "pairwise-pg", connector_instance_id: internalId },
            {
              data: { id: "shared", rank },
              emitted_at: now,
              key: "shared",
              stream: "items",
            },
            { deferIndexes: true }
          );
          bindings.push({
            connectorId: "pairwise-pg",
            connectorInstanceId: internalId,
            instanceId,
          });
        }
        const grant = {
          streams: [
            {
              fields: ["id", "rank"],
              instance_ids: ["account_a", "account_b"],
              name: "items",
            },
          ],
        };
        const first = await queryRecordsAcrossBindings(
          bindings,
          "items",
          grant,
          { limit: "1", order: "asc" },
          manifest
        );
        assert.equal(first.data[0]?.instance_id, "inst_z");
        assert.ok(first.next_cursor);
        const last = await queryRecordsAcrossBindings(
          bindings,
          "items",
          grant,
          { cursor: first.next_cursor, limit: "1", order: "asc" },
          manifest
        );
        assert.equal(last.data[0]?.instance_id, "inst_a");
        const baseline = await queryRecordsAcrossBindings(
          bindings,
          "items",
          grant,
          { changes_since: "beginning", limit: "10", order: "asc" },
          manifest
        );
        assert.ok(baseline.next_changes_since);
        await deleteRecord({ connector_id: "pairwise-pg", connector_instance_id: "account_a" }, "items", "shared");
        const changes = await queryRecordsAcrossBindings(
          bindings,
          "items",
          grant,
          { changes_since: baseline.next_changes_since, order: "asc" },
          manifest
        );
        assert.deepEqual(
          changes.data.map((record) => [record.instance_id, record.id, record.deleted]),
          [["inst_z", "shared", true]]
        );
      }
    );
  } finally {
    delete process.env.PDPP_EXPERIMENTAL_PAIRWISE_INSTANCE_IDENTITY;
  }
});
