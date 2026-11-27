// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import { observeDynamicBrowserSurfaceRuntimeInventory } from "../runtime/browser-surface/allocator-observation.ts";
import { createAllocatorReadinessCheck } from "../runtime/browser-surface/allocator-readiness.ts";
import { projectEphemeralBrowserSurfaceHealth } from "../runtime/browser-surface/ephemeral-health-projection.ts";
import { computeConnectionHealth } from "../runtime/connection-health.ts";

type Allocator = NonNullable<Parameters<typeof observeDynamicBrowserSurfaceRuntimeInventory>[0]["allocator"]>;
const now = new Date("2026-01-01T00:00:00.000Z");

function inventory(fetchImpl: typeof fetch): Allocator {
  return {
    listSurfaces: async () => {
      const response = await fetchImpl("/surfaces", { method: "GET" });
      return await response.json();
    },
  } as unknown as Allocator;
}

function health(snapshot: Awaited<ReturnType<typeof observeDynamicBrowserSurfaceRuntimeInventory>>) {
  return projectEphemeralBrowserSurfaceHealth({
    allocator_observation: snapshot.allocator_observation,
    connection_id: "connection",
    connection_kind: "browser-runtime",
    now: now.toISOString(),
    surface_mode: "dynamic-managed",
  });
}

for (const ready of [false, true]) {
  test(ready ? "empty ready inventory remains eligible" : "empty inventory cannot hide failed readiness", async () => {
    const paths: string[] = [];
    // biome-ignore lint/suspicious/useAwait: fetch stub must be async to match the fetch signature.
    const fetchImpl = (async (input, init) => {
      const path = String(input);
      paths.push(path);
      assert.equal(init?.method, "GET");
      assert.equal(init?.headers, undefined);
      if (path === "/surfaces") {
        return new Response("[]", { status: 200 });
      }
      assert.equal(path, "/readyz");
      return new Response(
        JSON.stringify(
          ready ? { ready: true } : { code: "image_missing", error: "n.eko container image is missing: ..." }
        ),
        { status: ready ? 200 : 503 }
      );
    }) as typeof fetch;
    const snapshot = await observeDynamicBrowserSurfaceRuntimeInventory({
      allocator: inventory(fetchImpl),
      now,
      readiness: createAllocatorReadinessCheck({ baseUrl: "", fetchImpl }),
      ttl_ms: 1000,
    });
    assert.deepEqual(paths, ["/surfaces", "/readyz"]);
    assert.deepEqual(snapshot.surfaces, []);
    assert.equal(snapshot.allocator_observation?.status, ready ? "available" : "unavailable");
    assert.equal(snapshot.allocator_observation?.reason, ready ? undefined : "http");
    assert.equal(health(snapshot).health_eligible, ready);
    const ownerHealth = computeConnectionHealth({
      activity: null,
      attention: null,
      backoff: null,
      coverage: null,
      ephemeralBrowserRuntime: health(snapshot),
      freshness: null,
      observedAt: now.toISOString(),
      outbox: null,
      projection: null,
      run: null,
      schedule: null,
    });
    const runtime = ownerHealth.conditions.find((condition) => condition.type === "RuntimeAvailable");
    assert.ok(runtime);
    assert.equal(runtime.status, ready ? "true" : "false");
    if (!ready) {
      assert.equal(runtime.remediation?.action, "check_runtime");
    }
  });
}

test("readiness fetch rejection is unavailable, not an empty healthy inventory", async () => {
  // biome-ignore lint/suspicious/useAwait: fetch stub must be async to match the fetch signature.
  const fetchImpl = (async (input) => {
    if (String(input) === "/surfaces") {
      return new Response("[]", { status: 200 });
    }
    throw new Error("unreachable");
  }) as typeof fetch;
  const snapshot = await observeDynamicBrowserSurfaceRuntimeInventory({
    allocator: inventory(fetchImpl),
    now,
    readiness: createAllocatorReadinessCheck({ baseUrl: "", fetchImpl }),
    ttl_ms: 1000,
  });
  assert.equal(snapshot.allocator_observation?.status, "unavailable");
  assert.equal(snapshot.allocator_observation?.reason, "fetch");
  assert.equal(health(snapshot).health_eligible, false);
});

test("readiness timeout settles even if fetch ignores abort", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  t.after(() => t.mock.timers.reset());
  let started: () => void = () => undefined;
  const readyStarted = new Promise<void>((resolve) => {
    started = resolve;
  });
  const captured: { signal?: AbortSignal | null | undefined } = {};
  const fetchImpl = (async (input, init) => {
    if (String(input) === "/surfaces") {
      return new Response("[]", { status: 200 });
    }
    captured.signal = init?.signal;
    started();
    return await new Promise<Response>(() => undefined);
  }) as typeof fetch;
  const pending = observeDynamicBrowserSurfaceRuntimeInventory({
    allocator: inventory(fetchImpl),
    now,
    readiness: createAllocatorReadinessCheck({ baseUrl: "", fetchImpl, timeoutMs: 10 }),
    ttl_ms: 1000,
  });
  await readyStarted;
  t.mock.timers.tick(10);
  const snapshot = await pending;
  assert.equal(captured.signal?.aborted, true);
  assert.equal(snapshot.allocator_observation?.status, "unavailable");
  assert.equal(snapshot.allocator_observation?.reason, "timeout");
});

test("omitting readiness preserves existing inventory behavior", async () => {
  let calls = 0;
  const allocator = {
    listSurfaces: () => {
      calls += 1;
      return Promise.resolve([]);
    },
  } as unknown as Allocator;
  const snapshot = await observeDynamicBrowserSurfaceRuntimeInventory({ allocator, now, ttl_ms: 1000 });
  assert.equal(calls, 1);
  assert.equal(snapshot.allocator_observation?.status, "available");
});

test("an absent allocator does not invoke readiness", async () => {
  let calls = 0;
  const snapshot = await observeDynamicBrowserSurfaceRuntimeInventory({
    allocator: undefined,
    now,
    readiness: () => {
      calls += 1;
      return Promise.resolve();
    },
    ttl_ms: 1000,
  });
  assert.equal(calls, 0);
  assert.equal(snapshot.allocator_observation?.status, "unknown");
});
