// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import express from "express";
import { normalizeDashboardReturnTo } from "./return-to.ts";
import { createOwnerAuthPlaceholder } from "../../../../../../reference-implementation/server/owner-auth.ts";

// Bare Node does not provide the RSC bundler's empty server-only marker.
// Keep the actual Next redirect implementation and return-path sanitizer.
const require = createRequire(import.meta.url);
require.cache[require.resolve("server-only")] = { exports: {} };
const { redirectToOwnerLogin } = await import("./login-redirect.ts");

async function loginDestination(returnTo) {
  let destination;
  await assert.rejects(redirectToOwnerLogin(returnTo), (error) => {
    assert.ok(error.digest.startsWith("NEXT_REDIRECT;"));
    destination = error.digest.split(";")[2];
    return true;
  });
  return destination;
}

test("consent challenge survives the real console redirect, login form, and authenticated login return", async () => {
  const challenge = "challenge-with+encoded/value";
  const returnTo = `/consent?challenge=${encodeURIComponent(challenge)}`;
  const destination = await loginDestination(returnTo);
  assert.equal(new URL(destination, "http://localhost").searchParams.get("return_to"), returnTo);
  const auth = createOwnerAuthPlaceholder({ password: "test-password" });
  const app = express();
  app.use(express.urlencoded({ extended: false }));
  auth.attachRoutes(app);
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  try {
    const origin = `http://127.0.0.1:${server.address().port}`;
    const login = await fetch(`${origin}${destination}`, { redirect: "manual" });
    const html = await login.text();
    const csrf = html.match(/name="_csrf" value="([^"]+)"/)[1];
    const hiddenReturn = html.match(/name="return_to" value="([^"]+)"/)[1];
    assert.equal(hiddenReturn, returnTo);
    const response = await fetch(`${origin}/owner/login`, {
      method: "POST",
      redirect: "manual",
      headers: {
        cookie: login.headers
          .getSetCookie()
          .map((cookie) => cookie.split(";")[0])
          .join("; "),
      },
      body: new URLSearchParams({ password: "test-password", _csrf: csrf, return_to: hiddenReturn }),
    });
    assert.equal(response.status, 302);
    assert.equal(response.headers.get("location"), returnTo);
    assert.equal(new URL(response.headers.get("location"), origin).searchParams.get("challenge"), challenge);
    assert.ok(response.headers.getSetCookie().some((cookie) => cookie.startsWith("pdpp_owner_session=")));
  } finally {
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});

test("consent allowlisting preserves segment boundaries and rejects unsafe login destinations", async () => {
  assert.equal(normalizeDashboardReturnTo("/consent"), "/consent");
  for (const unsafe of [
    "https://evil.example/consent",
    "//evil.example/consent",
    "/consent-evil?challenge=x",
    "/consent\\evil",
    "/consent?challenge=x\n",
    "/owner/login?return_to=/consent",
  ]) {
    assert.equal(normalizeDashboardReturnTo(unsafe), "/");
    assert.equal(new URL(await loginDestination(unsafe), "http://localhost").searchParams.get("return_to"), "/");
  }
});
