// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { REQUEST_DEADLINE_MS, requestReachability } from "./reachability-client.ts";

const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
const turn = () => new Promise((resolve) => setImmediate(resolve));

test("a read is a GET to the route handler and a write is a JSON POST; the answer comes back as sent", async () => {
  const seen: { url: string; init?: RequestInit }[] = [];
  const fetchMock = mock.method(globalThis, "fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    seen.push({ url: String(input), init });
    return json({ ok: true, data: { n: seen.length } });
  });
  try {
    assert.deepEqual(await requestReachability("/catalog"), { ok: true, data: { n: 1 } });
    assert.deepEqual(await requestReachability("/drafts", { providerId: "p" }), { ok: true, data: { n: 2 } });
    assert.equal(seen[0]!.url, "/api/reachability/catalog");
    assert.equal(seen[0]!.init?.method, "GET");
    assert.equal(seen[1]!.init?.method, "POST");
    assert.equal(seen[1]!.init?.body, JSON.stringify({ providerId: "p" }));
    assert.equal((seen[1]!.init?.headers as Record<string, string>)["content-type"], "application/json");
    // The owner's bearer is the server's; nothing in the request carries one.
    assert.ok(!JSON.stringify(seen.map((item) => item.init?.headers)).toLowerCase().includes("authorization"));
  } finally {
    fetchMock.mock.restore();
  }
});

test("a failure the server reports keeps its public code and message", async () => {
  const fetchMock = mock.method(globalThis, "fetch", async () =>
    json({ ok: false, code: "host_path_too_long", message: "plain words", serverMessage: "server words" }, 409)
  );
  try {
    assert.deepEqual(await requestReachability("/state"), {
      ok: false,
      code: "host_path_too_long",
      message: "plain words",
      serverMessage: "server words",
    });
  } finally {
    fetchMock.mock.restore();
  }
});

test("a body that is not an answer, or no connection at all, reads as the service not running", async () => {
  let mode: "html" | "down" = "html";
  const fetchMock = mock.method(globalThis, "fetch", async () => {
    if (mode === "down") throw new TypeError("fetch failed");
    return new Response("<html>login</html>", { status: 200 });
  });
  try {
    const page = await requestReachability("/state");
    assert.equal(!page.ok && page.code, "service_unreachable");
    mode = "down";
    const down = await requestReachability("/state");
    assert.equal(!down.ok && down.code, "service_unreachable");
  } finally {
    fetchMock.mock.restore();
  }
});

test("requests do not wait for each other: a slow read leaves the one sent after it to answer first", async () => {
  const gate: { release: () => void } = { release: () => undefined };
  const order: string[] = [];
  const fetchMock = mock.method(globalThis, "fetch", async (input: RequestInfo | URL) => {
    if (String(input).endsWith("/catalog")) await new Promise<void>((resolve) => (gate.release = resolve));
    return json({ ok: true, data: String(input) });
  });
  try {
    const slow = requestReachability("/catalog").then((result) => order.push(`slow ${String(result.ok)}`));
    const quick = requestReachability("/state").then((result) => order.push(`quick ${String(result.ok)}`));
    await quick;
    assert.deepEqual(order, ["quick true"], "/state was answered while /catalog was still open");
    gate.release();
    await slow;
    assert.deepEqual(order, ["quick true", "slow true"]);
  } finally {
    fetchMock.mock.restore();
  }
});

test("the deadline counts from the send: a request ends at its own deadline, whatever ran before it", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const fetchMock = mock.method(
    globalThis,
    "fetch",
    (_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      })
  );
  try {
    const first = requestReachability("/catalog");
    await turn();
    // Ten seconds pass before the second request is sent. It still gets its whole deadline.
    t.mock.timers.tick(10_000);
    const second = requestReachability("/drafts", {});
    await turn();
    t.mock.timers.tick(REQUEST_DEADLINE_MS - 10_000);
    assert.equal((await first).ok, false);
    let secondSettled = false;
    void second.then(() => {
      secondSettled = true;
    });
    await turn();
    assert.equal(secondSettled, false, "the second request is only ten seconds old");
    t.mock.timers.tick(10_000);
    const late = await second;
    assert.equal(!late.ok && late.code, "reachability_unavailable");
  } finally {
    fetchMock.mock.restore();
  }
});

test("a request the owner's ended session refuses sends the browser to sign in, then back here", async () => {
  const assigned: string[] = [];
  const dom = { location: { pathname: "/settings", search: "?tab=remote", assign: (to: string) => void assigned.push(to) } };
  Object.assign(globalThis, { window: dom });
  const fetchMock = mock.method(globalThis, "fetch", async () =>
    json({ ok: false, code: "owner_session_required", message: "Sign in." }, 401)
  );
  try {
    const result = await requestReachability("/state");
    assert.equal(result.ok, false);
    assert.deepEqual(assigned, ["/owner/login?return_to=%2Fsettings%3Ftab%3Dremote"]);
  } finally {
    fetchMock.mock.restore();
    Reflect.deleteProperty(globalThis, "window");
  }
});
