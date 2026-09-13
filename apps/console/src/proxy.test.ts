// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import { NextRequest } from "next/server";
import proxy from "./proxy.ts";

test("PAR and pending approval consent preserve the AS response and owner session", async (t) => {
  const requests: Request[] = [];
  t.mock.method(globalThis, "fetch", async (url: URL, init: RequestInit) => {
    requests.push(new Request(url, init));
    return new Response("owner login", {
      status: 302,
      headers: { location: "/owner/login?return_to=%2Fconsent", "set-cookie": "csrf=test; HttpOnly" },
    });
  });

  for (const query of ["request_uri=urn%3Apdpp%3Arequest%3Atest", "approval_id=approval-test"]) {
    const response = await proxy(
      new NextRequest(`http://console.test/consent?${query}`, {
        headers: { cookie: "pdpp_owner_session=test", accept: "text/html" },
      }),
    );
    assert.equal(response.status, 302);
    assert.equal(response.headers.get("location"), "/owner/login?return_to=%2Fconsent");
    assert.equal(response.headers.get("set-cookie"), "csrf=test; HttpOnly");
    assert.equal(response.headers.get("x-middleware-rewrite"), null);
    const upstream = requests.at(-1);
    assert.ok(upstream);
    assert.equal(new URL(upstream.url).pathname, "/consent");
    assert.equal(new URL(upstream.url).search, `?${query}`);
    assert.equal(upstream.headers.get("cookie"), "pdpp_owner_session=test");
    assert.equal(upstream.headers.get("x-forwarded-host"), "console.test");
    assert.equal(upstream.headers.get("x-forwarded-proto"), "http");
  }
  assert.equal(requests.length, 2);
});

test("challenge consent and incomplete requests stay with the console page", async (t) => {
  const fetchMock = t.mock.method(globalThis, "fetch", () => {
    throw new Error("challenge requests must not use the PAR proxy");
  });
  for (const query of [
    "",
    "?challenge=test",
    "?challenge=test&request_uri=old",
    "?challenge=&approval_id=old",
  ]) {
    const response = await proxy(new NextRequest(`http://console.test/consent${query}`));
    assert.equal(response.headers.get("x-middleware-next"), "1");
  }
  assert.equal(fetchMock.mock.callCount(), 0);
});
