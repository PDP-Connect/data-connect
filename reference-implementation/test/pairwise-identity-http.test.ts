// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { closePostgresStorage } from "../server/postgres-storage.ts";
import { drainConnectorInstanceIndexWork } from "../server/records.ts";
import { createRequestConnectorInstanceStore } from "../server/request-store-factories.ts";
import { withTemporaryPostgresDatabase } from "./helpers/postgres-temp-database.ts";
import { bearer, startPr89OAuthHarness } from "./seam-spike/pr89-oauth-harness.ts";

const retryAfterSecondsPattern = /^\d+$/;
const narrowingGuidancePattern = /narrow/i;

test("pairwise changes-page HTTP cursor rejects removal of changes_since", async () => {
  const prior = process.env.PDPP_EXPERIMENTAL_PAIRWISE_INSTANCE_IDENTITY;
  process.env.PDPP_EXPERIMENTAL_PAIRWISE_INSTANCE_IDENTITY = "1";
  const harness = await startPr89OAuthHarness({ databaseUrl: null });
  harness.setIntrospectionInterceptor(async (input, init) => {
    const response = await fetch(input, init);
    if (!response.ok) {
      return response;
    }
    const body = (await response.json()) as {
      authorization_details: {
        grant: { streams: { resources?: string[] }[] };
      }[];
    };
    // Authenticated AS test double grants the stream rather than one fixture resource.
    for (const detail of body.authorization_details) {
      for (const stream of detail.grant.streams) {
        Reflect.deleteProperty(stream, "resources");
      }
    }
    return new Response(JSON.stringify(body), {
      headers: response.headers,
      status: response.status,
    });
  });
  try {
    for (const id of ["artist:41", "artist:42", "artist:43"]) {
      // biome-ignore lint/performance/noAwaitInLoops: preserve deterministic change versions in the fixture.
      await harness.ingest({
        data: { id, name: id, observed_at: "2026-03-01T00:00:00Z" },
        emitted_at: "2026-03-01T00:00:00Z",
        key: id,
        stream: "top_artists",
      });
    }
    const headers = bearer(harness.token);
    const first = await fetch(`${harness.rsUrl}/v1/streams/top_artists/records?changes_since=beginning&limit=1`, {
      headers,
    });
    const page = (await first.json()) as { next_cursor: string };
    assert.equal(first.status, 200, JSON.stringify(page));
    assert.ok(page.next_cursor);
    const continuation = await fetch(
      `${harness.rsUrl}/v1/streams/top_artists/records?${new URLSearchParams({ cursor: page.next_cursor, limit: "1" })}`,
      { headers }
    );
    const failure = (await continuation.json()) as { error: { code: string } };
    assert.equal(continuation.status, 400, JSON.stringify(failure));
    assert.equal(failure.error.code, "invalid_cursor");
  } finally {
    await harness.close();
    if (prior === undefined) {
      Reflect.deleteProperty(process.env, "PDPP_EXPERIMENTAL_PAIRWISE_INSTANCE_IDENTITY");
    } else {
      process.env.PDPP_EXPERIMENTAL_PAIRWISE_INSTANCE_IDENTITY = prior;
    }
  }
});

test("pairwise HTTP capacity distinguishes temporary quota from an oversized query", async () => {
  const settings = [
    "PDPP_EXPERIMENTAL_PAIRWISE_INSTANCE_IDENTITY",
    "PDPP_PAIRWISE_QUERY_MAX_SESSIONS",
    "PDPP_PAIRWISE_QUERY_MAX_SNAPSHOT_BYTES",
  ] as const;
  const prior = settings.map((key) => process.env[key]);
  process.env.PDPP_EXPERIMENTAL_PAIRWISE_INSTANCE_IDENTITY = "1";
  process.env.PDPP_PAIRWISE_QUERY_MAX_SESSIONS = "1";
  const harness = await startPr89OAuthHarness({ databaseUrl: null });
  harness.setIntrospectionInterceptor(async (input, init) => {
    const response = await fetch(input, init);
    if (!response.ok) {
      return response;
    }
    const body = (await response.json()) as {
      authorization_details: {
        grant: { streams: { resources?: string[] }[] };
      }[];
    };
    for (const detail of body.authorization_details) {
      for (const stream of detail.grant.streams) {
        Reflect.deleteProperty(stream, "resources");
      }
    }
    return new Response(JSON.stringify(body), {
      headers: response.headers,
      status: response.status,
    });
  });
  try {
    for (const id of ["artist:41", "artist:42"]) {
      // biome-ignore lint/performance/noAwaitInLoops: preserve deterministic fixture ordering.
      await harness.ingest({
        data: {
          id,
          name: "x".repeat(2048),
          observed_at: "2026-03-01T00:00:00Z",
        },
        emitted_at: "2026-03-01T00:00:00Z",
        key: id,
        stream: "top_artists",
      });
    }
    const headers = bearer(harness.token);
    const url = `${harness.rsUrl}/v1/streams/top_artists/records?limit=1`;
    const first = await fetch(url, { headers });
    assert.equal(first.status, 200);
    const exhausted = await fetch(url, { headers });
    assert.equal(exhausted.status, 503);
    assert.match(exhausted.headers.get("Retry-After") ?? "", retryAfterSecondsPattern);
    const quotaFailure = (await exhausted.json()) as {
      error: { code: string };
    };
    assert.equal(quotaFailure.error.code, "query_capacity_exceeded");
    process.env.PDPP_PAIRWISE_QUERY_MAX_SNAPSHOT_BYTES = "1024";
    const oversized = await fetch(url, { headers });
    const permanentFailure = (await oversized.json()) as {
      error: { code: string; message: string };
    };
    assert.equal(oversized.status, 413, JSON.stringify(permanentFailure));
    assert.equal(permanentFailure.error.code, "resource_limit");
    assert.match(permanentFailure.error.message, narrowingGuidancePattern);
    assert.equal(oversized.headers.get("Retry-After"), null);
  } finally {
    await harness.close();
    for (const [index, key] of settings.entries()) {
      const value = prior[index];
      if (value === undefined) {
        Reflect.deleteProperty(process.env, key);
      } else {
        process.env[key] = value;
      }
    }
  }
});

async function provePairwiseHttp(databaseUrl: string | null): Promise<void> {
  process.env.PDPP_EXPERIMENTAL_PAIRWISE_INSTANCE_IDENTITY = "1";
  const harness = await startPr89OAuthHarness({ databaseUrl, lexical: true });
  let introspection: Record<string, unknown> | null = null;
  let mutation: "missing" | "conflicting" | "unknown-target" | null = null;
  harness.setIntrospectionInterceptor(async (input, init) => {
    const response = await fetch(input, init);
    if (response.ok) {
      introspection = (await response.clone().json()) as Record<string, unknown>;
      if (mutation) {
        const changed = structuredClone(introspection);
        const bindings = changed.pdpp_instance_bindings as Record<string, unknown>[];
        if (mutation === "missing") {
          delete changed.pdpp_instance_bindings;
        } else if (mutation === "conflicting") {
          changed.pdpp_instance_bindings = [
            ...bindings,
            {
              ...bindings[0],
              rs_instance: "foreign-account",
              stream: "another-stream",
            },
          ];
        } else {
          changed.pdpp_instance_bindings = bindings.map((binding) => ({
            ...binding,
            rs_instance: "missing-account",
          }));
        }
        return new Response(JSON.stringify(changed), {
          headers: response.headers,
          status: response.status,
        });
      }
    }
    return response;
  });
  try {
    await harness.ingest({
      data: {
        id: "artist:42",
        name: "pairwiseSearch",
        observed_at: "2026-03-01T00:00:00Z",
      },
      emitted_at: "2026-03-01T00:00:00Z",
      key: "artist:42",
      stream: "top_artists",
    });
    await drainConnectorInstanceIndexWork();
    const response = await fetch(`${harness.rsUrl}/v1/streams/top_artists/records`, { headers: bearer(harness.token) });
    const body = (await response.json()) as { data: Record<string, unknown>[] };
    assert.equal(response.status, 200, JSON.stringify(body));
    assert.equal(body.data.length, 1);
    const record = body.data[0]!;
    assert.match(String(record.instance_id), /^inst_/);
    assert.equal(record.connection_id, undefined);
    assert.equal(record.connector_instance_id, undefined);
    assert.ok(introspection);
    const wire = introspection as Record<string, unknown>;
    assert.equal(wire.pairwise_grant, undefined);
    const bindings = wire.pdpp_instance_bindings as {
      instance_id: string;
      rs_instance: string;
    }[];
    assert.ok(
      bindings.some(
        (binding) => binding.instance_id === record.instance_id && binding.rs_instance === harness.instanceId
      )
    );
    const detail = await fetch(
      `${harness.rsUrl}/v1/streams/top_artists/records/artist%3A42?instance_id=${record.instance_id}`,
      { headers: bearer(harness.token) }
    );
    assert.equal(detail.status, 200, await detail.clone().text());
    const foreign = await fetch(
      `${harness.rsUrl}/v1/streams/top_artists/records/artist%3A42?instance_id=inst_foreign`,
      { headers: bearer(harness.token) }
    );
    assert.equal(foreign.status, 404, await foreign.clone().text());
    const search = await fetch(`${harness.rsUrl}/v1/search?q=pairwiseSearch`, {
      headers: bearer(harness.token),
    });
    const results = (await search.json()) as {
      data: Record<string, unknown>[];
    };
    assert.equal(search.status, 200, JSON.stringify(results));
    assert.equal(results.data.length, 1);
    const hit = results.data[0]!;
    assert.equal(hit.instance_id, record.instance_id);
    assert.equal(hit.connection_id, undefined);
    assert.equal(hit.connector_instance_id, undefined);
    assert.ok(String(hit.record_url).includes(`instance_id=${record.instance_id}`));
    const followed = await fetch(`${harness.rsUrl}${hit.record_url}`, {
      headers: bearer(harness.token),
    });
    assert.equal(followed.status, 200, await followed.clone().text());
    const window = await fetch(
      `${harness.rsUrl}/v1/streams/top_artists/records/artist%3A42/field-window?field=name&instance_id=${record.instance_id}`,
      { headers: bearer(harness.token) }
    );
    assert.equal(window.status, 200, await window.clone().text());
    const unauthorizedIntrospection = await fetch(`${harness.asUrl}/introspect`, {
      body: new URLSearchParams({ token: harness.token }),
      method: "POST",
    });
    assert.equal(unauthorizedIntrospection.status, 401);
    await createRequestConnectorInstanceStore().updateStatus(harness.instanceId, {
      status: "revoked",
      updatedAt: "2026-10-10T00:00:00Z",
    });
    const retainedGrantRead = await fetch(
      `${harness.rsUrl}/v1/streams/top_artists/records/artist%3A42?instance_id=${record.instance_id}`,
      { headers: bearer(harness.token) }
    );
    assert.equal(retainedGrantRead.status, 200, await retainedGrantRead.clone().text());
    for (const invalid of ["missing", "conflicting", "unknown-target"] as const) {
      mutation = invalid;
      const rejected = await fetch(`${harness.rsUrl}/v1/streams/top_artists/records`, {
        headers: bearer(harness.token),
      });
      assert.equal(rejected.status, 403, `${invalid}: ${await rejected.clone().text()}`);
    }
  } finally {
    await harness.close();
    delete process.env.PDPP_EXPERIMENTAL_PAIRWISE_INSTANCE_IDENTITY;
  }
}

test("pairwise identity HTTP grant, authenticated introspection and record read compose (SQLite)", () =>
  provePairwiseHttp(null));

test("pairwise identity HTTP grant, authenticated introspection and record read compose (PostgreSQL)", {
  skip: process.env.PDPP_TEST_POSTGRES_URL ? false : "PDPP_TEST_POSTGRES_URL unset",
}, async () => {
  await withTemporaryPostgresDatabase(
    {
      closeConnections: closePostgresStorage,
      connectionString: process.env.PDPP_TEST_POSTGRES_URL!,
      databaseName: `pdpp_pairwise_http_${randomUUID().replaceAll("-", "")}`,
      templateName: null,
    },
    (databaseUrl) => provePairwiseHttp(databaseUrl)
  );
});
