// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import test from "node:test";
import { isOpenThroughRoute, normalizeOrigin } from "./remote-origin.ts";

test("the page is remote when its origin equals the route's origin", () => {
  assert.equal(isOpenThroughRoute("https://one.example.test", "https://one.example.test"), true);
});

test("both sides are normalized: case, default port, trailing path", () => {
  assert.equal(isOpenThroughRoute("https://One.Example.test", "https://one.example.test:443/"), true);
  assert.equal(isOpenThroughRoute("https://one.example.test", "https://one.example.test/console/settings?x=1"), true);
  assert.equal(normalizeOrigin("https://one.example.test:8443/a"), "https://one.example.test:8443");
});

test("a different scheme, host or port is not the route", () => {
  assert.equal(isOpenThroughRoute("http://one.example.test", "https://one.example.test"), false);
  assert.equal(isOpenThroughRoute("https://two.example.test", "https://one.example.test"), false);
  assert.equal(isOpenThroughRoute("https://one.example.test:8443", "https://one.example.test"), false);
});

test("a loopback page is never remote, even if the route says loopback", () => {
  for (const page of ["http://localhost:3000", "http://127.0.0.1:3000", "http://[::1]:3000"]) {
    assert.equal(isOpenThroughRoute(page, page), false, page);
    assert.equal(isOpenThroughRoute(page, "https://one.example.test"), false, page);
  }
});

test("an unknown or malformed route address is never remote", () => {
  for (const route of [null, undefined, "", "   ", "not a url", "ftp://one.example.test"]) {
    assert.equal(isOpenThroughRoute("https://one.example.test", route), false, String(route));
  }
  assert.equal(isOpenThroughRoute(null, "https://one.example.test"), false);
});
