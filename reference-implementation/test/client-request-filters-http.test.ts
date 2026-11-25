// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import test from "node:test";
// biome-ignore lint/correctness/noUndeclaredDependencies: This integration fixture uses the SDK declared by the vendored MCP workspace.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
// biome-ignore lint/correctness/noUndeclaredDependencies: This integration fixture uses the SDK declared by the vendored MCP workspace.
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { configureNativeManifest, registerConnector } from "../server/auth.ts";
import { closeDb, getDb } from "../server/db.ts";
import { startServer } from "../server/index.ts";
import { closePostgresStorage, postgresQuery } from "../server/postgres-storage.ts";
import { deleteRecord, ingestRecord } from "../server/records.ts";
import { createRequestConnectorInstanceStore } from "../server/request-store-factories.ts";
import { buildReadRequest } from "../vendor/cli/src/read/commands.ts";
import { createPdppMcpServer } from "../vendor/mcp-server/src/server.ts";
import { TEST_PRE_REGISTERED_PUBLIC_CLIENTS } from "./fixtures/demo-clients.ts";
import { closeTestServer } from "./helpers/close-test-server.ts";

interface Body {
  approval_review_revision: string;
  data: Array<{ id: string; deleted?: boolean; data: Record<string, unknown> }>;
  error: { code: string; param: string; message: string };
  field_capabilities: Record<string, unknown>;
  filter_fields: unknown;
  grant: { version: string; streams: Array<{ filter_fields?: unknown }> };
  has_more: boolean;
  meta?: { count?: unknown };
  next_changes_since: string;
  next_cursor: string;
  request_uri: string;
  token: string;
  value: number;
}

function origin(server: unknown): string {
  const address = (server as { address: () => AddressInfo }).address();
  return `http://${address.family === "IPv6" ? `[${address.address}]` : address.address}:${address.port}`;
}

for (const backend of ["sqlite", "postgres"] as const) {
  test(`client filters over HTTP: issuance, errors, pages, metadata, aggregates and changes (${backend})`, {
    skip: backend === "postgres" && !process.env.PDPP_TEST_POSTGRES_URL ? "PDPP_TEST_POSTGRES_URL unset" : false,
  }, async () => {
    const native = JSON.parse(
      readFileSync(new URL("../fixtures/seed-manifests/northstar-hr.json", import.meta.url), "utf8")
    );
    const runtime = JSON.parse(
      readFileSync(new URL("../fixtures/seed-manifests/spotify.json", import.meta.url), "utf8")
    );
    const stream = {
      consent_time_field: "time",
      name: "filter_items",
      primary_key: ["id"],
      query: { aggregations: { count: true }, range_filters: { amount: ["gte", "lt"], time: ["gte", "lt"] } },
      schema: {
        properties: {
          amount: { type: "number" },
          id: { type: "string" },
          opaque: { items: { type: "string" }, type: "array" },
          secret: { type: "string" },
          status: { type: ["string", "null"] },
          time: { format: "date-time", type: "string" },
        },
        required: ["id"],
        type: "object",
      },
      selection: { fields: true, resources: true },
      semantics: "mutable_state",
    };
    runtime.connector_id = runtime.connector_key;
    runtime.streams = [stream];
    Reflect.deleteProperty(runtime, "source_declaration");
    Reflect.deleteProperty(runtime, "selection_presets");
    Reflect.deleteProperty(runtime, "profiles");
    Reflect.deleteProperty(native.source_declaration, "selection_presets");
    native.storage_binding.connector_id = runtime.connector_id;
    native.streams = [stream];
    native.source_declaration.streams = [stream];
    const instance = `cin_client_filters_${backend}`;
    const server = await startServer({
      asPort: 0,
      dbPath: ":memory:",
      nativeManifest: native,
      rsPort: 0,
      ...(backend === "postgres"
        ? { databaseUrl: process.env.PDPP_TEST_POSTGRES_URL ?? "", storageBackend: "postgres" as const }
        : {}),
      preRegisteredPublicClients: TEST_PRE_REGISTERED_PUBLIC_CLIENTS,
      quiet: true,
      reconcilePolyfillManifests: false,
      startClientEventDeliveryWorker: false,
    });
    try {
      await registerConnector(runtime);
      const now = new Date().toISOString();
      await createRequestConnectorInstanceStore().upsert({
        connectorId: runtime.connector_id,
        connectorInstanceId: instance,
        createdAt: now,
        displayName: "Filter fixture",
        ownerSubjectId: "owner_local",
        sourceBinding: { fixture: instance },
        sourceBindingKey: instance,
        sourceKind: "manual",
        status: "active",
        updatedAt: now,
      });
      const asUrl = origin(server.asServer);
      const rsUrl = origin(server.rsServer);
      async function request(url: string, token?: string, payload?: unknown) {
        const response = await fetch(url, {
          ...(payload ? { body: JSON.stringify(payload), method: "POST" } : {}),
          headers: {
            Accept: "application/json",
            "Content-Type": "application/json",
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
          },
        });
        return { body: (await response.json()) as Body, status: response.status };
      }
      async function issue(version?: string) {
        const client = TEST_PRE_REGISTERED_PUBLIC_CLIENTS.at(-1);
        assert.ok(client);
        const initiated = await request(`${asUrl}/oauth/par`, undefined, {
          authorization_details: [
            {
              type: "https://pdpp.dev/data-access",
              ...(version ? { grant_version: version } : {}),
              access_mode: "continuous",
              purpose_code: "https://pdpp.dev/purpose/personalization",
              source: native.source_declaration.source,
              streams: [
                {
                  fields: ["id", "status", "amount", "time", "opaque"],
                  instance_ids: [instance],
                  name: stream.name,
                  time_range: { since: "2026-01-01T00:00:00Z" },
                },
              ],
            },
          ],
          client_id: client.client_id,
        });
        assert.equal(initiated.status, 201, JSON.stringify(initiated.body));
        const review = await request(`${asUrl}/consent/review`, undefined, {
          request_uri: initiated.body.request_uri,
          subject_id: "owner_local",
        });
        assert.equal(review.status, 200, JSON.stringify(review.body));
        const approved = await request(`${asUrl}/consent/approve`, undefined, {
          approval_review_revision: review.body.approval_review_revision,
          request_uri: initiated.body.request_uri,
        });
        assert.equal(approved.status, 200, JSON.stringify(approved.body));
        return approved.body;
      }
      const legacy = await issue();
      const modern = await issue("0.2.0");
      assert.equal(legacy.grant.version, "0.1.0");
      assert.equal(modern.grant.version, "0.2.0");
      const base = `${rsUrl}/v1/streams/${stream.name}`;
      const legacyRead = await request(`${base}/records?filter[secret]=x`, legacy.token);
      assert.equal(legacyRead.status, 400);
      assert.equal(legacyRead.body.error.code, "invalid_request");
      const fieldsDenied = await request(`${base}/records?fields=secret&filter[absent]=x`, modern.token);
      assert.equal(fieldsDenied.status, 403, JSON.stringify(fieldsDenied.body));
      assert.equal(fieldsDenied.body.error.param, "fields");
      const denied = await request(
        `${base}/records?filter[amount]=bad&filter[secret]=x&filter[absent]=x`,
        modern.token
      );
      assert.equal(denied.status, 403);
      assert.equal(denied.body.error.param, "filter[secret]");
      assert.equal(denied.body.error.message, "Fields not in grant: secret, absent");
      const invalid = await request(
        `${base}/records?filter[amount][gte]=10&filter[status]=x&filter[amount][gte]=11`,
        modern.token
      );
      assert.equal(invalid.status, 400);
      assert.equal(invalid.body.error.param, "filter[amount][gte]");
      const target = { connector_id: runtime.connector_id, connector_instance_id: instance };
      async function write(id: string, status: string, amount = 10, time = "2026-02-01T00:00:00Z") {
        await ingestRecord(target, { data: { amount, id, status, time }, key: id, stream: stream.name });
      }
      await write("a", "active");
      await write("b", "active", 11);
      await write("c", "inactive", 12);
      await write("old", "active", 10, "2025-01-01T00:00:00Z");
      const filters = "filter[status]=active&filter[amount][gte]=10";
      const first = await request(`${base}/records?fields=id&limit=1&${filters}`, modern.token);
      assert.equal(first.status, 200, JSON.stringify(first.body));
      assert.equal(first.body.has_more, true);
      assert.equal(first.body.data.length, 1);
      const [firstRecord] = first.body.data;
      assert.ok(firstRecord);
      assert.deepEqual(Object.keys(firstRecord.data), ["id"]);
      const second = await request(
        `${base}/records?fields=id&limit=1&filter[amount][gte]=10&filter[status]=active&cursor=${encodeURIComponent(first.body.next_cursor)}`,
        modern.token
      );
      assert.equal(second.status, 200, JSON.stringify(second.body));
      assert.equal(second.body.has_more, false);
      const [secondRecord] = second.body.data;
      assert.ok(secondRecord);
      assert.notEqual(secondRecord.id, firstRecord.id);
      const rebound = await request(
        `${base}/records?fields=id&limit=1&filter[amount][gte]=1e1&filter[status]=active&cursor=${encodeURIComponent(first.body.next_cursor)}`,
        modern.token
      );
      assert.equal(rebound.status, 400);
      assert.equal(rebound.body.error.code, "invalid_cursor");
      const feed = await request(`${base}/records?fields=id&${filters}&changes_since=beginning`, modern.token);
      assert.equal(feed.status, 200, JSON.stringify(feed.body));
      assert.ok(feed.body.next_changes_since);
      const reboundChanges = await request(
        `${base}/records?fields=id&filter[status]=active&filter[amount][gte]=1e1&changes_since=${encodeURIComponent(feed.body.next_changes_since)}`,
        modern.token
      );
      assert.equal(reboundChanges.status, 400);
      assert.equal(reboundChanges.body.error.code, "invalid_cursor");
      await write("a", "inactive");
      await write("c", "active", 12);
      const delta = await request(
        `${base}/records?fields=id&filter[amount][gte]=10&filter[status]=active&changes_since=${encodeURIComponent(feed.body.next_changes_since)}`,
        modern.token
      );
      assert.equal(delta.status, 200, JSON.stringify(delta.body));
      assert.equal(delta.body.data.find((record) => record.id === "a")?.deleted, true);
      assert.deepEqual(Object.keys(delta.body.data.find((record) => record.id === "a") ?? {}).sort(), [
        "deleted",
        "id",
        "instance_id",
        "object",
        "stream",
      ]);
      assert.equal(delta.body.data.find((record) => record.id === "c")?.deleted, undefined);
      assert.ok(
        delta.body.data.some((record) => record.id === "c"),
        "entry with unchanged projection is visible"
      );
      const cliRequest = buildReadRequest(
        "query-records",
        [stream.name],
        { "filter-json": '{"status":"active","amount":{"gte":"10"}}' },
        rsUrl
      );
      const cliRead = await request(cliRequest.url, modern.token);
      assert.equal(cliRead.status, 200, JSON.stringify(cliRead.body));
      assert.deepEqual(cliRead.body.data.map((record) => record.id).sort(), ["b", "c"]);
      const metadata = await request(base, modern.token);
      assert.equal(metadata.status, 200, JSON.stringify(metadata.body));
      assert.deepEqual(metadata.body.filter_fields, modern.grant.streams[0]?.filter_fields);
      const { server: mcpServer } = createPdppMcpServer({ accessToken: modern.token, providerUrl: rsUrl });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      const mcpClient = new Client({ name: "filter-fixture", version: "0.0.0" });
      try {
        await Promise.all([mcpClient.connect(clientTransport), mcpServer.connect(serverTransport)]);
        const mcpRead = await mcpClient.callTool({
          arguments: { filter: { amount: { gte: "10" }, status: "active" }, stream: stream.name },
          name: "query_records",
        });
        assert.notEqual(mcpRead.isError, true, JSON.stringify(mcpRead));
        const mcpSchema = await mcpClient.callTool({ arguments: { stream: stream.name }, name: "schema" });
        assert.notEqual(mcpSchema.isError, true, JSON.stringify(mcpSchema));
        assert.ok(JSON.stringify(mcpSchema).includes("t=number"));
      } finally {
        await mcpClient.close();
        await mcpServer.close();
      }
      const aggregate = await request(`${base}/aggregate?metric=count&${filters}`, modern.token);
      assert.equal(aggregate.status, 200, JSON.stringify(aggregate.body));
      assert.equal(aggregate.body.value, 2);
      const aggregateDenied = await request(`${base}/aggregate?metric=count&filter[secret]=x`, modern.token);
      assert.equal(aggregateDenied.status, 403);
      assert.equal(aggregateDenied.body.error.param, "filter[secret]");
      const aggregateLegacy = await request(`${base}/aggregate?metric=count&filter[status]=active`, legacy.token);
      assert.equal(aggregateLegacy.status, 400);
      // Freeze the request capability across a current declaration replacement.
      const replacement = structuredClone(native);
      replacement.source_declaration.streams[0].schema.properties.amount = { type: "string" };
      Reflect.deleteProperty(replacement.source_declaration.streams[0].query, "range_filters");
      replacement.streams = replacement.source_declaration.streams;
      Object.assign(native, replacement);
      configureNativeManifest(replacement);
      const after = await request(`${base}/records?${filters}`, modern.token);
      assert.equal(after.status, 200, JSON.stringify(after.body));
      assert.equal(after.body.data.length, 2);
      const afterMetadata = await request(base, modern.token);
      assert.deepEqual(afterMetadata.body.filter_fields, metadata.body.filter_fields);
      assert.deepEqual(afterMetadata.body.field_capabilities, metadata.body.field_capabilities);
      // Seed raw numeric JSON so both backends must avoid rounding during reads.
      const raw = '{"id":"precise","status":"active","amount":0.100000000000000001,"time":"2026-02-01T00:00:00Z"}';
      await write("precise", "active", 0.1);
      if (backend === "sqlite") {
        getDb()
          .prepare("UPDATE records SET record_json = ? WHERE connector_instance_id = ? AND record_key = ?")
          .run(raw, instance, "precise");
      } else {
        await postgresQuery(
          "UPDATE records SET record_json = $1::jsonb WHERE connector_instance_id = $2 AND record_key = $3",
          [raw, instance, "precise"]
        );
      }
      const precise = await request(`${base}/records?filter[amount]=0.100000000000000001`, modern.token);
      assert.equal(precise.status, 200, JSON.stringify(precise.body));
      assert.deepEqual(
        precise.body.data.map((record) => record.id),
        ["precise"]
      );
      const rounded = await request(`${base}/records?filter[amount]=0.1`, modern.token);
      assert.equal(rounded.status, 200);
      assert.equal(rounded.body.data.length, 0);
      const preciseAggregate = await request(
        `${base}/aggregate?metric=count&filter[amount]=0.100000000000000001`,
        modern.token
      );
      assert.equal(preciseAggregate.status, 200, JSON.stringify(preciseAggregate.body));
      assert.equal(preciseAggregate.body.value, 1);
      // A selective filter must find a match that sorts past any internal read batch.
      // The second match sorts past 500 rows, so a filtered read that works in
      // batches must carry its position across a batch boundary.
      for (let index = 0; index < 600; index += 1) {
        const id = `m${String(index).padStart(3, "0")}`;
        // biome-ignore lint/performance/noAwaitInLoops: Fixture writes are sequential.
        await write(id, index === 150 || index === 550 ? "rare" : "bulk");
      }
      const selective = await request(
        `${base}/records?fields=id&limit=1&order=asc&count=exact&filter[status]=rare`,
        modern.token
      );
      assert.equal(selective.status, 200, JSON.stringify(selective.body));
      assert.deepEqual(
        selective.body.data.map((record) => record.id),
        ["m150"]
      );
      assert.equal(selective.body.has_more, true);
      assert.deepEqual(selective.body.meta?.count, { kind: "exact", value: 2 });
      const selectiveNext = await request(
        `${base}/records?fields=id&limit=1&order=asc&count=exact&filter[status]=rare&cursor=${encodeURIComponent(selective.body.next_cursor)}`,
        modern.token
      );
      assert.equal(selectiveNext.status, 200, JSON.stringify(selectiveNext.body));
      assert.deepEqual(
        selectiveNext.body.data.map((record) => record.id),
        ["m550"]
      );
      assert.equal(selectiveNext.body.has_more, false);
      // A deletion in a filtered feed is the same bare tombstone as a filter
      // exit, and deleting a record the filter never matched reports nothing.
      const beforeDeletes = await request(`${base}/records?fields=id&${filters}&changes_since=beginning`, modern.token);
      assert.equal(beforeDeletes.status, 200, JSON.stringify(beforeDeletes.body));
      assert.ok(beforeDeletes.body.data.some((record) => record.id === "b"));
      assert.ok(!beforeDeletes.body.data.some((record) => record.id === "a"));
      await deleteRecord(target, stream.name, "b");
      await deleteRecord(target, stream.name, "a");
      const deletions = await request(
        `${base}/records?fields=id&${filters}&changes_since=${encodeURIComponent(beforeDeletes.body.next_changes_since)}`,
        modern.token
      );
      assert.equal(deletions.status, 200, JSON.stringify(deletions.body));
      assert.deepEqual(
        deletions.body.data.map((record) => record.id),
        ["b"]
      );
      assert.deepEqual(Object.keys(deletions.body.data[0] ?? {}).sort(), [
        "deleted",
        "id",
        "instance_id",
        "object",
        "stream",
      ]);
      assert.equal(deletions.body.data[0]?.deleted, true);
    } finally {
      await closeTestServer(server);
      closeDb();
      await closePostgresStorage();
    }
  });
}
