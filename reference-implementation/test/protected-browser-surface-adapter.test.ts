// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import { BindingControlError, BrowserBindingPlacementRefused } from "../runtime/binding-control.ts";
import { protectedBrowserSurfaceControllerOptions } from "../server/protected-browser-surface.ts";

type Admission = Parameters<typeof protectedBrowserSurfaceControllerOptions>[0];
type Preparation = Awaited<ReturnType<Admission["prepareRun"]>>;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, reject, resolve };
}

function fixture() {
  const prepared = deferred<Preparation>();
  const activation = deferred<void>();
  const activating = deferred<void>();
  const stopping = deferred<void>();
  let activationCalls = 0;
  let statusCalls = 0;
  let stopCalls = 0;
  const surface = {
    active_lease_id: "fixture-lease",
    browser_generation_hash: "fixture-generation",
    cdp_url: "ws://fixture.invalid",
    container_id: "fixture-container",
    health: "ready",
    profile_key: "fixture-profile",
  };
  const lease = {
    fencing_token: 1,
    lease_id: "fixture-lease",
    run_id: "fixture-run",
    status: "leased",
    surface_id: "fixture-surface",
  };
  // These are dependency fakes for adapter ordering, not an authority or Engine proof.
  const admission = {
    activateRun: () => {
      activationCalls += 1;
      activating.resolve(undefined);
      return activation.promise;
    },
    assertRunManifest: () => Promise.resolve(),
    disposeRun: () => Promise.resolve(),
    prepareRun: () => prepared.promise,
    statusRun: () => {
      statusCalls += 1;
      return Promise.resolve(surface);
    },
    stopRun: () => {
      stopCalls += 1;
      stopping.resolve(undefined);
      return Promise.resolve();
    },
  } as unknown as Admission;
  const manager = {
    config: { surfaceMode: "dynamic" },
    getLease: () => lease,
    getSurface: () => surface,
    listLeases: () => [lease],
  } as unknown as Parameters<typeof protectedBrowserSurfaceControllerOptions>[2];
  const options = protectedBrowserSurfaceControllerOptions(
    admission,
    {
      allocator: { credential: "fictional-unused-adapter-credential", timeoutMs: 1000, url: "http://127.0.0.1" },
      credential: "fictional-unused-authorizer-credential",
      policyIdentity: "fixture-policy",
      syncLifecycle: { policyExpiresAt: Date.now() + 60_000 },
    },
    manager,
    1000
  );
  const { beforeBrowserSurfaceLeaseEnsure, browserSurfaceAllocator, protectedBrowserSurfaceLifecycle } = options;
  assert.ok(beforeBrowserSurfaceLeaseEnsure && browserSurfaceAllocator && protectedBrowserSurfaceLifecycle);
  const preparation = {
    approved: true,
    reservation: { resource: { containerId: "fixture-container", generation: "fixture-generation" } },
  } as unknown as Preparation;
  return {
    activating,
    activation,
    get activationCalls() {
      return activationCalls;
    },
    ensure: () =>
      browserSurfaceAllocator.ensureSurface({
        connectorId: "fixture",
        profileKey: "fixture-profile",
        surfaceId: "fixture-surface",
      }),
    lifecycle: protectedBrowserSurfaceLifecycle,
    prepare: () =>
      beforeBrowserSurfaceLeaseEnsure({
        connectionId: "fixture-connection",
        runId: "fixture-run",
        surfaceId: "fixture-surface",
      }),
    ready: () => prepared.resolve(preparation),
    refuse: () => prepared.reject(new BrowserBindingPlacementRefused("network", "kind")),
    release: () => protectedBrowserSurfaceLifecycle.release("fixture-run"),
    get statusCalls() {
      return statusCalls;
    },
    get stopCalls() {
      return stopCalls;
    },
    stopping,
  };
}

const turn = () => new Promise<void>((resolve) => setImmediate(resolve));

test("adapter never dispatches activation when release wins during preparation", async () => {
  const h = fixture();
  h.activation.resolve(undefined);
  const preparing = h.prepare();
  const ensured = Promise.allSettled([h.ensure()]);
  const releasing = h.release();
  h.ready();
  await preparing;
  await releasing;
  assert.equal((await ensured)[0]?.status, "rejected");
  assert.equal(h.activationCalls, 0, "a stopped run must not dispatch activation after preparation resolves");
  assert.equal(h.stopCalls, 1);
});

test("concurrent adapter ensures join a failed activation without returning status", async () => {
  const h = fixture();
  h.ready();
  await h.prepare();
  const observed = Promise.allSettled([h.ensure(), h.ensure()]);
  const error = new Error("fixture activation failed");
  try {
    await h.activating.promise;
    await turn();
    assert.equal(h.activationCalls, 1);
    assert.equal(h.statusCalls, 0, "status must wait for the shared activation outcome");
    h.activation.reject(error);
    const results = await observed;
    for (const result of results) {
      assert.equal(result.status, "rejected");
      assert.ok(result.status === "rejected" && result.reason === error);
    }
  } finally {
    h.activation.resolve(undefined);
    await observed;
  }
});

test("adapter cleanup joins an in-flight activation after requesting stop", async () => {
  const h = fixture();
  h.ready();
  await h.prepare();
  const ensured = Promise.allSettled([h.ensure()]);
  await h.activating.promise;
  let completed = false;
  const releasing = h.release().then(() => {
    completed = true;
  });
  try {
    await h.stopping.promise;
    await turn();
    assert.equal(completed, false, "cleanup cannot finish while activation is unsettled");
  } finally {
    h.activation.resolve(undefined);
    await releasing;
    await ensured;
  }
  assert.equal((await ensured)[0]?.status, "rejected", "a cancelled activation cannot hand off a resource");
  assert.equal(h.stopCalls, 1);
});

test("concurrent adapter ensures share successful activation then stop once", async () => {
  const h = fixture();
  h.ready();
  await h.prepare();
  const results = Promise.all([h.ensure(), h.ensure()]);
  try {
    await h.activating.promise;
    await turn();
    assert.equal(h.activationCalls, 1);
    assert.equal(h.statusCalls, 0);
  } finally {
    h.activation.resolve(undefined);
  }
  assert.equal((await results).length, 2);
  await h.release();
  assert.equal(h.stopCalls, 1);
});

for (const refused of [false, true]) {
  test(`terminal retirement drops retained preparation and manifest (${refused ? "refused" : "completed"})`, async () => {
    const h = fixture();
    await Array.from({ length: 40 }).reduce(async (previous) => {
      await previous;
      await h.lifecycle.admit({
        connectionId: "fixture-connection",
        manifest: { fictional: true },
        runId: "fixture-run",
      });
      const preparing = h.prepare();
      if (refused) {
        h.refuse();
        await assert.rejects(Promise.resolve(preparing));
      } else {
        h.ready();
        await preparing;
      }
      assert.deepEqual(h.lifecycle.retainedState?.(), { aliases: 1, manifests: 1, runs: 1 });
      await assert.rejects(
        Promise.resolve(h.lifecycle.retire?.("fixture-run")),
        BindingControlError,
        "unverified runs must remain fenced"
      );
      await h.release();
      await h.release();
      await h.lifecycle.retire?.("fixture-run");
      assert.deepEqual(
        h.lifecycle.retainedState?.(),
        { aliases: 0, manifests: 0, runs: 0 },
        "terminal snapshots must be disposed"
      );
    }, Promise.resolve());
  });
}

test("exact model replay: preparing run cannot retire before terminal evidence", async () => {
  const h = fixture();
  const preparing = h.prepare();
  try {
    await assert.rejects(
      Promise.resolve(h.lifecycle.retire?.("fixture-run")),
      BindingControlError,
      "preparing resource fence cannot retire"
    );
  } finally {
    h.ready();
    await preparing;
    await h.release();
    await h.lifecycle.retire?.("fixture-run");
  }
});
