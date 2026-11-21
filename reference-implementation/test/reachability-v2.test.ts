// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import test from "node:test";
import type { ConfigurationDraft as Draft, RouteView as Route, Candidate as RouteCandidate } from "@tnunamak/gozar";
import { requireRouteApproval, requireSetupApproval } from "../server/reachability/approvals.ts";
import { readConfigurationDraft } from "../server/reachability/draft-read.ts";
import { ConfigurationDraftSession, configurationFromSetup } from "../server/reachability/drafts.ts";
import { hostCapability, observationText, routePresentation } from "../server/reachability/presentation.ts";
import { createHostSecretBackend } from "../server/reachability/secret-backend.ts";
import { projectRoute } from "../server/reachability/projection.ts";
import { fakeRouteScenarios } from "@tnunamak/gozar/testing";
import fixture from "./fixtures/reachability/configuration.json" with { type: "json" };

const draft = fixture as Draft;
const action = draft.configuration.actions[0]!;

test("host rejects route approval at setup before any effect", () => {
  let effects = 0;
  assert.throws(
    () => {
      requireSetupApproval(action, { candidateToken: "route-token", kind: "route" });
      effects++;
    },
    { code: "consent_kind_mismatch" }
  );
  assert.equal(effects, 0);
});

test("host rejects setup approval at start before any effect", () => {
  let effects = 0;
  assert.throws(
    () => {
      requireRouteApproval({} as RouteCandidate, { digest: action.digest, kind: "setup" });
      effects++;
    },
    { code: "consent_kind_mismatch" }
  );
  assert.equal(effects, 0);
});

test("setup snapshot must agree with result revision and scope", () => {
  const result = {
    catalogRevision: "catalog-one",
    configuration: draft.configuration,
    configurationRevision: draft.configuration.revision,
    nextAction: null,
    schemaVersion: 1 as const,
    scopeId: draft.scopeId,
    state: "complete" as const,
  };
  assert.equal(configurationFromSetup(result), draft.configuration);
  assert.throws(() => configurationFromSetup({ ...result, configurationRevision: "other" }), {
    code: "setup_configuration_inconsistent",
  });
  assert.throws(() => configurationFromSetup({ ...result, scopeId: "other" }), {
    code: "setup_configuration_inconsistent",
  });
});

test("reload resumes from the public current draft, never cached actions", async () => {
  const session = new ConfigurationDraftSession(null);
  assert.throws(() => session.action(action.id, draft.configuration.revision), { code: "draft_read_required" });
  let reads = 0;
  await session.reload(
    {
      readConfigurationDraft: async (request) => {
        assert.equal(request.draftId, draft.draftId);
        reads++;
        return draft;
      },
    },
    { draftId: draft.draftId, home: "fixture-home", providerId: action.consent!.scope.providerId }
  );
  assert.equal(reads, 1);
  assert.equal(session.action(action.id, draft.configuration.revision), action);
  assert.throws(() => session.action(action.id, "stale"), { code: "configuration_stale" });
  session.invalidate();
  assert.throws(() => session.action(action.id, draft.configuration.revision), { code: "draft_read_required" });
});

test("missing draft read and unknown draft fail explicitly and invalidate held actions", async () => {
  const request = { draftId: "unknown-draft", home: "fixture-home", providerId: action.consent!.scope.providerId };
  await assert.rejects(readConfigurationDraft({}, request), { code: "draft_read_unavailable" });
  const session = new ConfigurationDraftSession(draft);
  await assert.rejects(
    session.reload(
      {
        readConfigurationDraft: async () => {
          throw Object.assign(new Error("unknown draft"), { code: "draft_not_found" });
        },
      },
      request
    ),
    { code: "draft_not_found" }
  );
  assert.throws(() => session.snapshot, { code: "draft_read_required" });
});

test("host capabilities preserve denied and undeclared states", () => {
  assert.deepEqual(hostCapability({}, "new.capability"), { known: false, reason: "host-capability-undeclared" });
  assert.deepEqual(hostCapability({ "new.capability": { known: true, value: false } }, "new.capability"), {
    known: true,
    value: false,
  });
  assert.equal(observationText({ known: true, value: false }), "false");
  assert.equal(observationText({ known: true, value: 0 }), "0");
  assert.equal(observationText({ known: true, value: "" }), "(empty)");
});

test("missing secret bridge is unknown with no file fallback", async () => {
  const backend = createHostSecretBackend(null);
  assert.deepEqual(await backend.presence({ handle: "handle", scopeId: "scope" }), {
    known: false,
    reason: "secret_backend_unavailable",
  });
  await assert.rejects(async () => backend.withSecret({ handle: "handle", scopeId: "scope" }, async () => true), {
    code: "secret_backend_unavailable",
  });
});

test("unsupported proof refresh is unpublished and offers only stop", () => {
  const result = routePresentation({} as Route, null, 0, "proof_refresh_unsupported");
  assert.deepEqual(result, { actions: ["stop"], label: "Unpublished", reason: "proof_refresh_unsupported" });
});

test("host journal records intent before effects and marks a lost reply unknown, possibly live", async () => {
  const { mkdtemp, readFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { ReachabilityOperations } = await import("../server/reachability/operations.ts");
  const root = await mkdtemp(join(tmpdir(), "reachability-journal-"));
  try {
    const operations = new ReachabilityOperations(root);
    let sawIntent = false;
    let release!: () => void;
    const wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = await operations.start("start", null, async (operationId) => {
      const intent = JSON.parse(await readFile(join(root, `${operationId}.json`), "utf8"));
      sawIntent = intent.operationId === operationId && intent.stage === "applying";
      release();
      return new Promise<never>(() => {
        /* Simulate a reply lost with the old host. */
      });
    });
    await wait;
    assert.equal(sawIntent, true);
    // A replacement host has no running task or returned handle. It must not
    // call a library effect or describe this durable intent as Off/failed.
    const replacement = new ReachabilityOperations(root);
    const recovered = await replacement.read(started.operationId);
    assert.equal(recovered.stage, "unknown-possibly-live");
    assert.equal(recovered.handle, null);
    assert.equal((await replacement.list())[0]?.stage, "unknown-possibly-live");
    await replacement.requestStop(started.operationId);
    assert.equal((await new ReachabilityOperations(root).read(started.operationId)).stopTombstone, true);
    assert.deepEqual(recovered.recovery, { available: false, reason: "public_operation_recovery_unavailable" });
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("host journal settles a refused start whose library view confirms cleanup, and keeps owed starts as debt", async () => {
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { ReachabilityOperations } = await import("../server/reachability/operations.ts");
  const root = await mkdtemp(join(tmpdir(), "reachability-refusal-"));
  try {
    const operations = new ReachabilityOperations(root, true);
    const seed = fakeRouteScenarios()[0]!;
    const refusal = (cleanup: Route["cleanup"]) =>
      Object.assign(new Error("A retained session already owns this directory"), {
        code: "route_conflict",
        route: { ...seed, cleanup, published: null, state: "released" as const },
      });
    const settle = async (cleanup: Route["cleanup"]) => {
      const { operationId } = await operations.start("start", null, async () => {
        throw refusal(cleanup);
      });
      for (let attempt = 0; attempt < 100; attempt++) {
        const record = await operations.read(operationId);
        if (record.stage !== "applying") return record;
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      throw new Error("the journal never settled the start");
    };
    const refused = await settle({ nextAction: null, state: "confirmed" });
    assert.equal(refused.stage, "settled");
    assert.equal(refused.cleanupConfirmed, true);
    assert.equal(refused.recovery, null);
    assert.deepEqual(refused.handle, seed.handle);
    // The same refusal without confirmed cleanup may have left a route: it stays owed.
    const owed = await settle({ nextAction: null, state: "unconfirmed" });
    assert.equal(owed.stage, "unknown-possibly-live");
    assert.deepEqual(owed.recovery, { available: true, reason: "route_reconciliation_required" });
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("route projections retain required proof and cleanup keys, including unknown observations", () => {
  for (const route of fakeRouteScenarios()) {
    const projected = projectRoute(route)
    assert.equal(Object.hasOwn(projected.verification, "subject"), true)
    assert.equal(Object.hasOwn(projected.verification, "observedAt"), true)
    assert.equal(Object.hasOwn(projected.cleanup, "nextAction"), true)
    assert.deepEqual(projected.verification.subject, route.verification.subject)
    assert.equal(
      projected.verification.observedAt,
      route.verification.observedAt
    )
    assert.equal(projected.cleanup.state, route.cleanup.state)
  }
})

test("state and event projections bind provider identity to the exact journaled creation handle", async () => {
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { ReachabilityOperations } = await import("../server/reachability/operations.ts");
  const { mountOwnerReachability } = await import("../server/routes/owner-reachability.ts");
  type Context = Parameters<typeof mountOwnerReachability>[1];
  const root = await mkdtemp(join(tmpdir(), "reachability-provider-projection-"));
  try {
    const operations = new ReachabilityOperations(root);
    const seed = fakeRouteScenarios()[0]!;
    let created!: Route;
    const start = await operations.start("start", null, async (operationId) => {
      created = { ...seed, operationId };
      return created;
    }, {
      instanceId: "fixture-instance", bootId: "fixture-boot", providerId: "localhost-run",
      configurationRevision: "fixture-revision", target: "127.0.0.1:37807",
      usage: { kind: "session", lifetimeMs: 3_600_000 },
      expectedOrigin: null, consentFactsDigest: "fixture-digest",
    });
    // Await the actual journal settlement, not just the start response.
    let settled = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      if ((await operations.read(start.operationId)).stage === "settled") { settled = true; break; }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.ok(settled, "creation handle is durably bound before projection");
    assert.equal(projectRoute(created).providerId, null, "a bare RouteView never implies a provider");
    const missing = "00000000-0000-0000-0000-000000000000";
    const routes = [
      created,
      { ...created, handle: { ...created.handle, generation: created.handle.generation + 1 } },
      { ...created, operationId: missing },
      { ...created, handle: { ...created.handle, id: created.handle.id + "-other" } },
    ];
    const handlers = new Map<string, (...args: any[]) => Promise<unknown>>();
    const app = {
      get(path: string, ...args: any[]) { handlers.set(path, args.at(-1)); },
      post() {},
    };
    const noop = () => undefined;
    mountOwnerReachability(app as Parameters<typeof mountOwnerReachability>[0], {
      operations,
      service: { state: () => ({ routes, reasons: {}, starting: false, lifecycle: null }), presentation: (route: Route) => routePresentation(route, null, Date.now()) } as unknown as Context["service"],
      setups: { list: async () => [] } as unknown as Context["setups"],
      requireToken: noop, requireOwner: noop, requireCsrf: noop,
      usage: () => ({ kind: "session", lifetimeMs: 3_600_000 }),
    });
    const read = operations.read.bind(operations);
    const counts = new Map<string, number>();
    operations.read = async (id) => {
      counts.set(id, (counts.get(id) ?? 0) + 1);
      return read(id);
    };
    for (const path of ["/state", "/events"]) {
      counts.clear();
      let response: any;
      const res = { setHeader() {}, status() { return res; }, json(body: unknown) { response = body; } };
      await handlers.get("/v1/owner/reachability" + path)!({ params: {} }, res);
      assert.deepEqual(response.data.routes.map((route: { providerId: string | null }) => route.providerId),
        ["localhost-run", null, null, null]);
      // The approved digest comes from the same verified record: present for the matching start,
      // null when the handle generation, handle id or operation id does not match.
      assert.deepEqual(
        response.data.routes.map((route: { approvedConsentFactsDigest: string | null }) => route.approvedConsentFactsDigest),
        ["fixture-digest", null, null, null]);
      // State reads each journal record once through its bounded list and never
      // falls back per route, so a route missing from the list keeps unknown
      // attribution without a journal read; events deduplicate per operation ID.
      assert.equal(counts.get(start.operationId), 1);
      assert.equal(counts.get(missing), path === "/state" ? undefined : 1);
    }
    operations.read = async () => { throw new Error("journal read unavailable"); };
    // Events need only the guarded creator lookup, not the separate operation-list endpoint.
    let response: any;
    const res = { setHeader() {}, status() { return res; }, json(body: unknown) { response = body; } };
    await handlers.get("/v1/owner/reachability/events")!({ params: {} }, res);
    assert.deepEqual(response.data.routes.map((route: { providerId: string | null }) => route.providerId),
      [null, null, null, null]);
    assert.deepEqual(
      response.data.routes.map((route: { approvedConsentFactsDigest: string | null }) => route.approvedConsentFactsDigest),
      [null, null, null, null]);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("state marks a route as owner-stopped only when a settled stop names its exact handle", async () => {
  const { mountOwnerReachability } = await import("../server/routes/owner-reachability.ts");
  type Context = Parameters<typeof mountOwnerReachability>[1];
  const seed = fakeRouteScenarios()[0]!;
  const stopped = { ...seed, handle: { ...seed.handle, id: "stopped-handle" }, operationId: null };
  const died = { ...seed, handle: { ...seed.handle, id: "died-handle" }, operationId: null };
  const otherKind = { ...seed, handle: { ...seed.handle, id: "kind-mismatch" }, operationId: null };
  // Journal shape of a stop (operations.ts record: kind stop, stage settled, failureCode null, handle).
  const stopRecord = (handle: { kind: string; id: string; generation: number }) => ({
    operationId: "11111111-1111-1111-1111-111111111111", kind: "stop", stage: "settled", failureCode: null,
    recovery: null, handle,
  });
  // The third record names the same id and generation as the third route but a
  // different kind: not the same handle, so it is not that route's stop intent.
  const foreignKind = stopRecord({ kind: "attached", id: "kind-mismatch", generation: seed.handle.generation });
  const handlers = new Map<string, (...args: any[]) => Promise<unknown>>();
  const app = { get(path: string, ...args: any[]) { handlers.set(path, args.at(-1)); }, post() {} };
  const noop = () => undefined;
  mountOwnerReachability(app as Parameters<typeof mountOwnerReachability>[0], {
    operations: { list: async () => [stopRecord({ kind: seed.handle.kind, id: "stopped-handle", generation: seed.handle.generation }), foreignKind], read: async () => null } as unknown as Context["operations"],
    service: { state: () => ({ routes: [stopped, died, otherKind], reasons: {}, starting: false, lifecycle: null }), presentation: (route: Route) => routePresentation(route, null, Date.now()) } as unknown as Context["service"],
    setups: { list: async () => [] } as unknown as Context["setups"],
    requireToken: noop, requireOwner: noop, requireCsrf: noop,
    usage: () => ({ kind: "session", lifetimeMs: 3_600_000 }),
  });
  let response: any;
  const res = { setHeader() {}, status() { return res; }, json(body: unknown) { response = body; } };
  await handlers.get("/v1/owner/reachability/state")!({ params: {} }, res);
  assert.deepEqual(response.data.routes.map((route: { stopRequested: boolean }) => route.stopRequested), [true, false, false]);
});

// The shape an owner-managed durable route reports: it has no expiry to observe.
function presentedRoute(now: number): { route: Route; current: Parameters<typeof routePresentation>[1] } {
  const target = "127.0.0.1:37807";
  const base = fakeRouteScenarios({ target }).find((item) => item.handle.kind === "durable" && item.routeState === "verified");
  assert.ok(base);
  const subject = base.verification.subject;
  assert.ok(subject);
  const route: Route = {
    ...base,
    expiresAt: { known: false as const, reason: "not-observed" },
    verification: {
      ...base.verification,
      checkedAt: new Date(now - 1000).toISOString(),
      observedAt: new Date(now - 1000).toISOString(),
      validUntil: { known: true as const, value: new Date(now + 14_000).toISOString() },
    },
  };
  return { current: subject, route };
}

test("a route with no observable expiry presents as Verified while its proof is fresh", () => {
  const now = Date.now();
  const { route, current } = presentedRoute(now);
  // Control: the same route with an expiry that has not passed is Verified, so the missing expiry is the only difference.
  const bounded = { ...route, expiresAt: { known: true as const, value: new Date(now + 60_000).toISOString() } };
  assert.equal(routePresentation(bounded, current, now).label, "Verified");
  assert.equal(routePresentation(route, current, now).label, "Verified");
});

test("an unknown route expiry never outlives the proof, and a known past expiry still blocks", () => {
  const now = Date.now();
  const { route, current } = presentedRoute(now);
  const lapsed = {
    ...route,
    verification: { ...route.verification, validUntil: { known: true as const, value: new Date(now - 1).toISOString() } },
  };
  assert.equal(routePresentation(lapsed, current, now).label, "Unpublished");
  const unboundedProof = {
    ...route,
    verification: { ...route.verification, validUntil: { known: false as const, reason: "not-observed" } },
  } as Route;
  assert.equal(routePresentation(unboundedProof, current, now).label, "Unpublished");
  const expired = { ...route, expiresAt: { known: true as const, value: new Date(now - 1).toISOString() } };
  assert.equal(routePresentation(expired, current, now).label, "Unpublished");
  assert.equal(routePresentation(route, { ...current, bootId: "new-boot" } as typeof current, now).label, "Unpublished");
});
