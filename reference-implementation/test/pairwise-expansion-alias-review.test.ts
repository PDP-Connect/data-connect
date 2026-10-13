// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import test from "node:test";
import { exec, referenceQueries } from "../lib/db.ts";
import { seedPreRegisteredClients } from "../server/auth.ts";
import { buildPairwiseOwnerBindings } from "../server/pairwise-identity.ts";
import { drainConnectorInstanceIndexWork, ingestRecord } from "../server/records.ts";
import { createRequestConnectorInstanceStore } from "../server/request-store-factories.ts";
import { TEST_PRE_REGISTERED_PUBLIC_CLIENTS } from "./fixtures/demo-clients.ts";
import { bearer, type Pr89OAuthHarness, startPr89OAuthHarness } from "./seam-spike/pr89-oauth-harness.ts";

async function ownerHeaders(h: Pr89OAuthHarness) {
  await seedPreRegisteredClients(TEST_PRE_REGISTERED_PUBLIC_CLIENTS);
  const headers = { "Content-Type": "application/x-www-form-urlencoded" };
  const post = (path: string, fields: Record<string, string>) =>
    fetch(`${h.asUrl}${path}`, { body: new URLSearchParams(fields), headers, method: "POST" });
  const deviceResponse = await post("/oauth/device_authorization", { client_id: "cli_longview" });
  assert.equal(deviceResponse.status, 200);
  const device = (await deviceResponse.json()) as { device_code: string; user_code: string };
  const approval = await post("/device/approve", { subject_id: "owner_local", user_code: device.user_code });
  assert.equal(approval.status, 200);
  const response = await post("/oauth/token", {
    client_id: "cli_longview",
    device_code: device.device_code,
    grant_type: "urn:ietf:params:oauth:grant-type:device_code",
  });
  assert.equal(response.status, 200);
  const token = (await response.json()) as { access_token: string };
  return bearer(token.access_token);
}
interface ResponseRecord {
  connection_id?: string;
  connector_instance_id?: string;
  data: { nested: { blob_ref: { fetch_url: string }; resource_ref: unknown }[] };
  expanded: Record<string, ResponseRecord | ExpandedList | null>;
  id: string;
  instance_id: string;
  object: string;
}
interface ExpandedList {
  data: ResponseRecord[];
  has_more: boolean;
  object: string;
}
interface DiscoveryList {
  data: { instance_id: string; name: string; record_count: number }[];
}
interface SearchList {
  data: { instance_id: string; record_url: string }[];
}
async function json<T>(h: Pr89OAuthHarness, path: string, headers: Record<string, string>) {
  const response = await fetch(`${h.rsUrl}${path}`, { headers });
  const body = (await response.json()) as T;
  assert.equal(response.status, 200, JSON.stringify(body));
  return body;
}
async function withOwner(run: (h: Pr89OAuthHarness, headers: Record<string, string>) => Promise<void>) {
  const previous = process.env.PDPP_EXPERIMENTAL_PAIRWISE_INSTANCE_IDENTITY;
  process.env.PDPP_EXPERIMENTAL_PAIRWISE_INSTANCE_IDENTITY = "1";
  const h = await startPr89OAuthHarness({ databaseUrl: null, lexical: true });
  try {
    await run(h, await ownerHeaders(h));
  } finally {
    await h.close();
    if (previous === undefined) {
      delete process.env.PDPP_EXPERIMENTAL_PAIRWISE_INSTANCE_IDENTITY;
    } else {
      process.env.PDPP_EXPERIMENTAL_PAIRWISE_INSTANCE_IDENTITY = previous;
    }
  }
}
async function seedExpansion(h: Pr89OAuthHarness) {
  const connectorId = "review-expansion",
    instanceId = "review-expansion-account";
  const manifest = {
    capabilities: { human_interaction: [] },
    connector_id: connectorId,
    display_name: "Review expansion",
    manifest_uri: "https://example.test/expansion",
    protocol_version: "0.1.0",
    streams: [
      {
        name: "parents",
        primary_key: ["id"],
        query: { expand: [{ default_limit: 1, max_limit: 10, name: "children" }, { name: "featured" }] },
        relationships: [
          { cardinality: "has_many", foreign_key: "parent_id", name: "children", stream: "children" },
          { cardinality: "has_one", foreign_key: "parent_id", name: "featured", stream: "children" },
        ],
        schema: {
          properties: { id: { type: "string" }, parent_id: { type: "string" } },
          required: ["id"],
          type: "object",
        },
        selection: { fields: true, resources: true },
        semantics: "mutable_state",
      },
      {
        name: "children",
        primary_key: ["id"],
        schema: {
          properties: {
            id: { type: "string" },
            nested: { items: { type: "object" }, type: "array" },
            parent_id: { type: "string" },
          },
          required: ["id", "parent_id"],
          type: "object",
        },
        selection: { fields: true, resources: true },
        semantics: "mutable_state",
      },
    ],
    version: "1.0.0",
  };
  const registered = await fetch(`${h.asUrl}/connectors`, {
    body: JSON.stringify(manifest),
    headers: { "Content-Type": "application/json" },
    method: "POST",
  });
  assert.equal(registered.status, 201, await registered.clone().text());
  const now = new Date().toISOString();
  await createRequestConnectorInstanceStore().upsert({
    connectorId,
    connectorInstanceId: instanceId,
    createdAt: now,
    displayName: instanceId,
    ownerSubjectId: "owner_local",
    sourceBinding: { account: instanceId },
    sourceBindingKey: instanceId,
    sourceKind: "account",
    status: "active",
    updatedAt: now,
  });
  const target = { connector_id: connectorId, connector_instance_id: instanceId };
  await Promise.all(["p", "empty"].map((key) => ingestRecord(target, { data: { id: key }, key, stream: "parents" })));
  await Promise.all(
    ["c1", "c2"].map((key) =>
      ingestRecord(target, {
        data: {
          id: key,
          nested: [
            {
              blob_ref: { blob_id: "nested-blob", mime_type: "text/plain" },
              resource_ref: { record_id: "p", source_id: connectorId, stream: "parents" },
            },
          ],
          parent_id: "p",
        },
        key,
        stream: "children",
      })
    )
  );
  const binding = (await buildPairwiseOwnerBindings("owner_local")).find((entry) => entry.rs_instance === instanceId);
  assert.ok(binding);
  return { connectorId, handle: binding.instance_id };
}
function assertChild(record: ResponseRecord, handle: string) {
  assert.equal(record.object, "record");
  assert.equal(record.instance_id, handle, "every expanded record carries its parent's instance handle");
  assert.equal(record.connection_id, undefined);
  assert.equal(record.connector_instance_id, undefined);
  const [nested] = record.data.nested;
  assert.ok(nested);
  const url = new URL(nested.blob_ref.fetch_url, "https://example.test");
  assert.equal(url.searchParams.get("instance_id"), handle);
  assert.equal(url.searchParams.has("connection_id"), false);
  assert.equal(url.searchParams.has("connector_instance_id"), false);
  assert.deepEqual(nested.resource_ref, {
    instance_id: handle,
    record_id: "p",
    source_id: "review-expansion",
    stream: "parents",
  });
}
for (const endpoint of ["list", "detail"] as const) {
  for (const relation of ["children", "featured"] as const) {
    test(`pairwise owner ${endpoint} ${relation === "children" ? "has_many" : "has_one"} expansion decorates every child and preserves metadata`, async () => {
      await withOwner(async (h, headers) => {
        const { connectorId, handle } = await seedExpansion(h);
        const query = new URLSearchParams({ connector_id: connectorId, "expand[]": relation, instance_id: handle });
        if (endpoint === "list") {
          query.delete("instance_id");
        }
        const path = `/v1/streams/parents/records${endpoint === "detail" ? "/p" : ""}?${query}`;
        const parent =
          endpoint === "detail"
            ? await json<ResponseRecord>(h, path, headers)
            : (await json<ExpandedList>(h, path, headers)).data.find((record) => record.id === "p");
        assert.ok(parent);
        assert.equal(parent.instance_id, handle);
        assert.equal(parent.connection_id, undefined);
        assert.equal(parent.connector_instance_id, undefined);
        const expanded = parent.expanded[relation];
        assert.ok(expanded);
        if (relation === "children") {
          assert.equal(expanded.object, "list");
          assert.ok("has_more" in expanded);
          assert.equal(expanded.has_more, true);
          assert.equal(expanded.data.length, 1);
          for (const child of expanded.data) {
            assertChild(child, handle);
          }
          assert.deepEqual(
            Object.keys(expanded).sort(),
            ["data", "has_more", "object"],
            "list metadata is preserved without record fields"
          );
        } else {
          assert.ok("instance_id" in expanded);
          assertChild(expanded, handle);
          query.set("instance_id", handle);
          const empty = await json<ResponseRecord>(h, `/v1/streams/parents/records/empty?${query}`, headers);
          assert.equal(empty.expanded.featured, null);
        }
      });
    });
  }
}
test("pairwise owner source aliases reuse one handle across records, discovery, search, blob and delete", async () => {
  await withOwner(async (h, headers) => {
    const instance = await createRequestConnectorInstanceStore().get(h.instanceId);
    assert.ok(instance);
    const local = instance.connectorId,
      canonical = (h.declaration.source as { id: string }).id;
    assert.notEqual(local, canonical, "the equality below is vacuous unless the two source names differ");
    await h.ingest({
      data: {
        blob_ref: { blob_id: "alias-blob" },
        id: "artist:42",
        name: "aliasIdentitySearch",
        observed_at: "2026-03-01T00:00:00Z",
      },
      emitted_at: "2026-03-01T00:00:00Z",
      key: "artist:42",
      stream: "top_artists",
    });
    await drainConnectorInstanceIndexWork();
    exec(referenceQueries.blobsInsertBlob, [
      "alias-blob",
      local,
      h.instanceId,
      "top_artists",
      "artist:42",
      "text/plain",
      5,
      "sha256_test",
      Buffer.from("alias"),
    ]);
    exec(referenceQueries.blobsInsertBinding, ["alias-blob", local, h.instanceId, "top_artists", "artist:42"]);
    const bindings = await buildPairwiseOwnerBindings("owner_local");
    const canonicalBinding = bindings.find(
      (entry) => entry.rs_instance === h.instanceId && entry.source_id === canonical
    );
    const localBinding = bindings.find((entry) => entry.rs_instance === h.instanceId && entry.source_id === local);
    assert.ok(canonicalBinding);
    assert.ok(localBinding);
    const canonicalHandle = canonicalBinding.instance_id;
    const localHandle = localBinding.instance_id;
    assert.equal(localHandle, canonicalHandle, "one stored owner instance has one handle across source aliases");
    const handles = new Set<string>();
    {
      // Owner HTTP routes address a source by its local connector key. The canonical name is a binding alias only
      // (it answers "Unknown source" as connector_id), so the route blocks run for `local`.
      const source = local;
      const query = new URLSearchParams({ connector_id: source, instance_id: canonicalHandle });
      const listQuery = new URLSearchParams({ connector_id: source });
      const list = await json<ExpandedList>(h, `/v1/streams/top_artists/records?${listQuery}`, headers);
      const [first] = list.data;
      assert.ok(first);
      handles.add(first.instance_id);
      const detail = await json<ResponseRecord>(h, `/v1/streams/top_artists/records/artist%3A42?${query}`, headers);
      handles.add(detail.instance_id);
      const discovery = await json<DiscoveryList>(h, `/v1/streams?connector_id=${encodeURIComponent(source)}`, headers);
      const entry = discovery.data.find((item) => item.name === "top_artists" && item.instance_id === canonicalHandle);
      assert.ok(entry, "discovery lists top_artists under the record's owner handle");
      assert.equal(entry.record_count, 1);
      const blob = await fetch(`${h.rsUrl}/v1/blobs/alias-blob?${query}`, { headers });
      assert.equal(blob.status, 200, await blob.clone().text());
      assert.equal(await blob.text(), "alias");
    }
    const search = await json<SearchList>(h, "/v1/search?q=aliasIdentitySearch", headers);
    assert.equal(search.data.length, 1);
    const [hit] = search.data;
    assert.ok(hit);
    handles.add(hit.instance_id);
    assert.equal(new URL(hit.record_url, h.rsUrl).searchParams.get("instance_id"), canonicalHandle);
    assert.deepEqual([...handles], [canonicalHandle]);
    {
      const source = local;
      await h.ingest({
        data: { id: "artist:42", name: "aliasIdentitySearch", observed_at: "2026-03-01T00:00:00Z" },
        emitted_at: "2026-03-01T00:00:00Z",
        key: "artist:42",
        stream: "top_artists",
      });
      const query = new URLSearchParams({ connector_id: source, instance_id: canonicalHandle });
      const response = await fetch(`${h.rsUrl}/v1/streams/top_artists/records/artist%3A42?${query}`, {
        headers,
        method: "DELETE",
      });
      assert.equal(response.status, 204, await response.clone().text());
      const afterDelete = await fetch(`${h.rsUrl}/v1/streams/top_artists/records/artist%3A42?${query}`, { headers });
      assert.equal(afterDelete.status, 404, "record is gone after DELETE");
    }
  });
});
