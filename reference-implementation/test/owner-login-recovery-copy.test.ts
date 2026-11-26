// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import test from "node:test";
import { createOwnerAuthPlaceholder, type OwnerAuthPlaceholder } from "../server/owner-auth.ts";
import { createMemoryOwnerSessionStore } from "../server/owner-session.ts";
import { createOwnerPasswordVerifier } from "../server/owner-password-verifier.ts";

type App = Parameters<OwnerAuthPlaceholder["attachRoutes"]>[0];
type Handler = Parameters<App["get"]>[1];
for (const source of ["desktop", "env", "app"] as const) test(`login recovery hint follows ${source} credential on initial and failed forms`, async () => {
  const routes = new Map<string, Handler>();
  const auth = createOwnerAuthPlaceholder({
    ...(source === "app" ? { passwordVerifier: await createOwnerPasswordVerifier("test-only-not-a-real-password") } : { password: "test-only-not-a-real-password", passwordManagedByDesktop: source === "desktop" }),
    sessionStore: createMemoryOwnerSessionStore(),
  });
  auth.attachRoutes({ get(path, handler) { routes.set(`GET ${path}`, handler); }, post(path, handler) { routes.set(`POST ${path}`, handler); } });
  let html = "";
  const headers = new Map<string, string | string[]>();
  const response: Parameters<Handler>[1] = {
    end() {}, json() { return response; }, redirect() { assert.fail("unexpected redirect"); },
    send(body) { html = body; return response; }, setHeader(name, value) { headers.set(name, value); return response; }, status() { return response; },
  };
  const get = routes.get("GET /owner/login"); const post = routes.get("POST /owner/login");
  assert.ok(get); assert.ok(post);
  await get({ headers: { accept: "text/html" }, query: {} }, response);
  const expected = source === "desktop" ? /Forgot it\? Open DataConnect on the computer that runs it\. Settings can show or change the password\./ : /Forgot it\? Ask whoever installed DataConnect to set a new one\./;
  assert.match(html, expected);
  assert.ok(html.indexOf('id="hosted-ui-password"') < html.indexOf('Forgot it?'));
  const csrf = html.match(/name="_csrf" value="([^"]+)"/)?.[1]; assert.ok(csrf);
  const cookies = headers.get("Set-Cookie");
  const cookie = (Array.isArray(cookies) ? cookies : [cookies]).filter(Boolean).map(value => value?.split(';')[0]).join('; ');
  await post({ headers: { accept: "text/html", "content-type": "application/x-www-form-urlencoded", cookie }, body: { password: "incorrect", _csrf: csrf } }, response);
  assert.match(html, /That password did not work/);
  assert.match(html, expected);
});
