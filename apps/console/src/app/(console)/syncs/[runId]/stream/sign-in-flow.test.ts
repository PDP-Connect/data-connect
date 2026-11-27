// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import test from "node:test";
import { signInDestination, setupStatusHref, scheduleSignInContinuation } from "./sign-in-flow.ts";

test("nothing needed and ended sign-ins go to the same connection and copy", () => {
  const href = setupStatusHref("account/a", "copy/b");
  assert.equal(href, "/connect/status/account%2Fa?run_id=copy%2Fb");
  for (const state of ["running", "ended"] as const) assert.equal(signInDestination(state, href), href);
  assert.equal(signInDestination("resolved", href), null);
  assert.equal(signInDestination("preparing", href), null);
});
test("signed-in continuation waits two seconds and can be cancelled", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const visited: string[] = [];
  const cancel = scheduleSignInContinuation("/connect/status/account?run_id=copy", (href) => visited.push(href));
  t.mock.timers.tick(1999); assert.equal(visited.length, 0);
  t.mock.timers.tick(1); assert.deepEqual(visited, ["/connect/status/account?run_id=copy"]);
  cancel();
  const cancelNext = scheduleSignInContinuation("/never", (href) => visited.push(href));
  cancelNext(); t.mock.timers.tick(2000); assert.equal(visited.length, 1);
});
