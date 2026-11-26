// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import test from "node:test";
import { initialLifecycle } from "../server/reachability/lifecycle.ts";
import { ReachabilityService } from "../server/reachability/service.ts";
import { mountOwnerReachability } from "../server/routes/owner-reachability.ts";

type Handler = (request: unknown, response: unknown) => Promise<unknown>;

const DIGEST = "consent-v1:abc";
const reviewFor = (expiresAt: string) => ({
  id: "rev-1",
  draftId: "d1",
  query: { target: "127.0.0.1:1", usage: { kind: "session", lifetimeMs: 1000 } },
  candidate: {
    providerId: "svc",
    candidateToken: "tok",
    consentFactsDigest: DIGEST,
    disclosure: { revision: "1" },
    expiresAt,
    configuration: { revision: "r1", values: {} },
    consent: { facts: [], disclosures: {}, scope: { kind: "route" }, consentFactsDigest: DIGEST },
  },
});

// A real service holding one review, behind the real approve route.
async function approve(expiresAt: string, digest = DIGEST) {
  const service = new ReachabilityService({} as never, {
    acknowledgeDisconnect: async () => undefined,
    identity: { bootId: "b", instanceId: "i" },
    query: {},
  } as never);
  const inner = service as unknown as { reviews: Map<string, unknown>; lifecycle: unknown };
  inner.reviews.set("rev-1", reviewFor(expiresAt));
  inner.lifecycle = { ...initialLifecycle(), phase: "review", approvalIdentity: "rev-1" };
  const routes = new Map<string, Handler>();
  const app = {
    get: (path: string, ...args: Handler[]) => routes.set(`GET ${path}`, args.at(-1) as Handler),
    post: (path: string, ...args: Handler[]) => routes.set(`POST ${path}`, args.at(-1) as Handler),
  };
  let started = 0;
  const operations = {
    start: async () => {
      started++;
      return { operationId: "op-1" };
    },
  };
  const pass = async (_r: unknown, _s: unknown, next?: () => void) => next?.();
  mountOwnerReachability(app as never, {
    service,
    operations: operations as never,
    setups: {} as never,
    requireToken: pass,
    requireOwner: pass,
    requireCsrf: pass,
    usage: () => ({}) as never,
  } as never);
  const sent: { status: number; payload: any } = { status: 200, payload: null };
  const response = {
    setHeader: () => undefined,
    status: (code: number) => {
      sent.status = code;
      return response;
    },
    json: (payload: unknown) => {
      sent.payload = payload;
      return response;
    },
  };
  await routes.get("POST /v1/owner/reachability/operations")!(
    { body: { reviewId: "rev-1", kind: "route", consentFactsDigest: digest, acknowledgeDisconnect: true }, params: {} },
    response
  );
  return { sent, started: () => started, service: inner };
}

test("approving a review that expired since it was shown is refused before the 202, and starts nothing", async () => {
  const result = await approve("2000-01-01T00:00:00.000Z");
  assert.equal(result.sent.status, 409);
  assert.equal(result.sent.payload.error.code, "consent_expired");
  assert.equal(result.started(), 0);
});

test("approving with a digest the review does not hold is refused before the 202", async () => {
  const result = await approve("2999-01-01T00:00:00.000Z", "consent-v1:other");
  assert.equal(result.sent.status, 409);
  assert.equal(result.sent.payload.error.code, "consent_changed");
  assert.equal(result.started(), 0);
});

test("a valid review is accepted, and the precheck changes nothing", async () => {
  const result = await approve("2999-01-01T00:00:00.000Z");
  assert.equal(result.sent.status, 202);
  assert.equal(result.started(), 1);
  assert.ok(result.service.reviews.has("rev-1"), "the review is still there for apply");
});

for (const kind of ["session", "durable"] as const) {
  test(`concurrent apply consumes one review once for ${kind}`, { timeout: 5000 }, async () => {
    let release!: (target: string) => void;
    const target = new Promise<string>((resolve) => { release = resolve; });
    let targetReads = 0, acknowledgements = 0;
    const effects: { method: string; operationId: string }[] = [];
    const create = (method: string) => async (input: { operationId: string }) => {
      effects.push({ method, operationId: input.operationId });
      return {
        handle: { id: "route-" + input.operationId, generation: 1, kind },
        cleanup: { state: "none" },
        verification: { status: "verified" },
        published: "https://fixture.invalid",
      };
    };
    const service = new ReachabilityService({
      expose: create("expose"),
      ensureRoute: create("ensureRoute"),
      watchRoutes: async function* () {},
    } as never, {
      acknowledgeDisconnect: async () => { acknowledgements++; },
      currentTarget: () => { targetReads++; return target; },
      identity: { bootId: "b", instanceId: "i" },
      query: {},
    } as never);
    const inner = service as unknown as { reviews: Map<string, unknown>; lifecycle: unknown };
    const review = reviewFor("2999-01-01T00:00:00.000Z");
    inner.reviews.set("rev-1", { ...review, query: { ...review.query,
      usage: kind === "session" ? review.query.usage : { kind: "durable" } } });
    inner.lifecycle = { ...initialLifecycle(), phase: "review", approvalIdentity: "rev-1" };
    const input = { kind: "route", consentFactsDigest: DIGEST, acknowledgeDisconnect: true };
    const first = service.apply("op-A", "rev-1", input);
    const second = service.apply("op-B", "rev-1", input);
    // Install rejection handlers before releasing either currentTarget read.
    const settled = Promise.allSettled([first, second]);
    assert.equal(targetReads, 2, "both calls reached the asynchronous target check");
    assert.equal(effects.length, 0);
    assert.equal(acknowledgements, 0);
    release(review.query.target);
    const results = await settled;
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    const rejected = results.filter((result) => result.status === "rejected");
    assert.equal(rejected.length, 1);
    assert.equal((rejected[0] as PromiseRejectedResult).reason.code, "review_not_found");
    assert.equal(acknowledgements, 1, "the losing call performs no host effect");
    assert.equal(effects.length, 1);
    assert.equal(effects[0]!.method, kind === "durable" ? "ensureRoute" : "expose");
    assert.equal(inner.reviews.has("rev-1"), false);
  });
}
