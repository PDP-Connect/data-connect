// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { mock, test } from "node:test";

let refClient: Promise<typeof import("./ref-client.ts")> | null = null;
let operatorApprovals: Promise<typeof import("./operator-approvals.ts")> | null = null;

function loadRefClient(): Promise<typeof import("./ref-client.ts")> {
  refClient ??= (async () => {
    mock.module("server-only", { exports: {} });
    mock.module("./verify-session.ts", {
      exports: { verifyDashboardSession: async () => undefined },
    });
    mock.module(new URL("./owner-token.ts", import.meta.url).href, {
      exports: {
        getAsInternalUrl: () => "http://as.example.test",
        withOwnerSessionCookie: async (init: RequestInit = {}) => init,
        ReferenceServerUnreachableError: class extends Error {},
      },
    });
    return import("./ref-client.ts");
  })();
  return refClient;
}

function loadOperatorApprovals(): Promise<typeof import("./operator-approvals.ts")> {
  operatorApprovals ??= (async () => {
    await loadRefClient();
    return import("./operator-approvals.ts");
  })();
  return operatorApprovals;
}

test("listConnectorSummaries sends a bounded page request and returns its response", async (t) => {
  const client = await loadRefClient();
  const responseBody = { data: [{ id: "connection-a" }], has_more: true, next_cursor: "next-page" };
  const requests: URL[] = [];
  const fetchMock = t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    assert.equal(init?.method ?? "GET", "GET");
    const url = new URL(input instanceof Request ? input.url : input);
    assert.equal(url.pathname, "/_ref/connectors");
    requests.push(url);
    return Response.json(responseBody);
  });

  const result = await client.listConnectorSummaries({
    connectorId: ["fitbit", "strava"],
    cursor: "opaque-cursor",
    limit: 25,
  });
  const defaultPage = await client.listConnectorSummaries();

  assert.equal(fetchMock.mock.callCount(), 2);
  assert.deepEqual(
    requests.map((url) => [...url.searchParams.entries()]),
    [
      [
        ["connector_id", "fitbit"],
        ["connector_id", "strava"],
        ["cursor", "opaque-cursor"],
        ["limit", "25"],
      ],
      [["limit", "100"]],
    ]
  );
  assert.deepEqual(result, responseBody);
  assert.deepEqual(defaultPage, responseBody);
});

test("listConnectorSummaries scopes a known route id without pagination parameters", async (t) => {
  const client = await loadRefClient();
  const responseBody = { data: [{ id: "connection-a" }] };
  const fetchMock = t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    assert.equal(init?.method ?? "GET", "GET");
    const url = new URL(input instanceof Request ? input.url : input);
    assert.equal(url.pathname, "/_ref/connectors");
    assert.deepEqual([...url.searchParams.entries()], [["connection", "route-id"]]);
    return Response.json(responseBody);
  });

  const result = await client.listConnectorSummaries({ connectionRouteId: "route-id" });

  assert.equal(fetchMock.mock.callCount(), 1);
  assert.deepEqual(result, responseBody);
});

test("listConnectionsByConnector binds the full connector-scoped response", async (t) => {
  const client = await loadRefClient();
  const rows = [{ connector_id: "fitbit", connector_instance_id: "instance-a" }];
  const fetchMock = t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    assert.equal(init?.method ?? "GET", "GET");
    const url = new URL(input instanceof Request ? input.url : input);
    assert.equal(url.pathname, "/_ref/connections");
    assert.deepEqual([...url.searchParams.entries()], [["connector_id", "fitbit"]]);
    return Response.json({ data: rows, object: "list" });
  });

  const result = await client.listConnectionsByConnector("fitbit");

  assert.equal(fetchMock.mock.callCount(), 1);
  assert.deepEqual(result, rows);
});

test("getPendingApprovalReview posts the opaque id and binds the materialized review response", async (t) => {
  const client = await loadRefClient();
  const approvalId = "approval/opaque-7";
  const artifact = { client: { client_id: "client-1" }, requested_scopes: ["records.read"] };
  const reviewResponse = {
    approval_review: artifact,
    approval_review_revision: "revision-4",
    batch: true,
    request_uri: "urn:request:4",
  };
  const requests: Array<{ body: string | undefined; method: string | undefined; url: URL }> = [];
  const fetchMock = t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input);
    requests.push({ body: init?.body?.toString(), method: init?.method, url });
    return requests.length === 1
      ? Response.json({ approval_id: approvalId, kind: "consent" })
      : Response.json(reviewResponse);
  });

  const result = await client.getPendingApprovalReview(approvalId);

  assert.equal(fetchMock.mock.callCount(), 2);
  assert.deepEqual(
    requests.map(({ method, url }) => [method ?? "GET", `${url.pathname}${url.search}`]),
    [
      ["GET", "/_ref/approvals/approval%2Fopaque-7"],
      ["POST", "/consent/review"],
    ]
  );
  assert.deepEqual(JSON.parse(requests[1]?.body ?? "{}"), { approval_id: approvalId });
  assert.deepEqual(result, {
    approval_id: approvalId,
    approval_review: artifact,
    approval_review_revision: "revision-4",
    batch: true,
    kind: "consent",
    object: "approval_review",
    request_uri: "urn:request:4",
  });
});

test("approvePendingApproval posts only the reviewed revision and request URI", async (t) => {
  const approvals = await loadOperatorApprovals();
  const fetchMock = t.mock.method(globalThis, "fetch", async () => Response.json({ ok: true }));

  assert.deepEqual(
    await approvals.approvePendingApproval({
      approvalId: "approval-9",
      approvalReviewRevision: "review-revision-2",
      kind: "consent",
      requestUri: "urn:request:9",
    }),
    { ok: true }
  );

  assert.equal(fetchMock.mock.callCount(), 1);
  const [input, init] = fetchMock.mock.calls[0]?.arguments ?? [];
  assert.equal(new URL(input instanceof Request ? input.url : input).pathname, "/consent/approve");
  assert.equal(init?.method, "POST");
  assert.deepEqual(JSON.parse(String(init?.body)), {
    approval_review_revision: "review-revision-2",
    request_uri: "urn:request:9",
  });
});
