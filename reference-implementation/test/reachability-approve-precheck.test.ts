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
    configuration: { revision: "r1" },
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
