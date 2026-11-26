// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test, { mock } from "node:test";
import * as navigation from "next/navigation";
import * as React from "react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { bannedCopyProblems, visibleText } from "./banned-copy.ts";
import { type GettingReadyDeps, getServiceReady, type ReadinessCheck } from "./getting-ready.ts";

Object.assign(globalThis, { React });
mock.module("server-only", { namedExports: {} });
mock.module("next/navigation", {
  namedExports: { ...navigation, useRouter: () => ({ refresh() {}, replace() {}, push() {} }) },
});

const bodyModule = import("./getting-ready.tsx");

/** A clock the test moves by hand, so no test waits in real time. */
function fakeClock() {
  let now = 0;
  return {
    now: () => now,
    sleep: async (ms: number) => {
      now += ms;
    },
  };
}

function deps(overrides: Partial<GettingReadyDeps> & Pick<GettingReadyDeps, "check">): GettingReadyDeps {
  const clock = fakeClock();
  return {
    install: async () => ({ ok: true }),
    needsInstall: true,
    now: clock.now,
    sleep: clock.sleep,
    ...overrides,
  };
}

// Design "Getting ready": "When ready, the form appears on the same page without a click."
test("getting ready: installs once, then opens the form when the server reports ready", async () => {
  let installs = 0;
  let checks = 0;
  const outcome = await getServiceReady(
    deps({
      check: async (): Promise<ReadinessCheck> => (++checks < 3 ? { state: "waiting" } : { href: "/connect/browser-session/amazon", state: "ready" }),
      install: async () => {
        installs += 1;
        return { ok: true };
      },
    })
  );
  assert.deepEqual(outcome, { href: "/connect/browser-session/amazon", kind: "ready" });
  assert.equal(installs, 1);
  assert.equal(checks, 3);
});

test("getting ready: a service already on this computer skips the install call", async () => {
  let installs = 0;
  const outcome = await getServiceReady(
    deps({
      check: async () => ({ href: "/x", state: "ready" }),
      install: async () => {
        installs += 1;
        return { ok: true };
      },
      needsInstall: false,
    })
  );
  assert.equal(outcome.kind, "ready");
  assert.equal(installs, 0);
});

// Design "Getting ready: Failed": the server's message is kept for "What went wrong".
test("getting ready: a failed install ends as failed and keeps the server's message", async () => {
  const outcome = await getServiceReady(
    deps({ check: async () => ({ state: "waiting" }), install: async () => ({ message: "registry unreachable", ok: false }) })
  );
  assert.deepEqual(outcome, { detail: "registry unreachable", kind: "failed" });
});

test("getting ready: still waiting after the limit ends as failed instead of waiting forever", async () => {
  let checks = 0;
  const outcome = await getServiceReady(
    deps({
      check: async (): Promise<ReadinessCheck> => {
        checks += 1;
        return { state: "waiting" };
      },
      intervalMs: 1000,
      maxWaitMs: 5000,
    })
  );
  assert.equal(outcome.kind, "failed");
  assert.ok(checks >= 5 && checks <= 7, `checked ${checks} times`);
});

test("getting ready: a read that throws ends as failed", async () => {
  const outcome = await getServiceReady(
    deps({
      check: async () => {
        throw new Error("Cannot reach resource server");
      },
    })
  );
  assert.deepEqual(outcome, { detail: "Cannot reach resource server", kind: "failed" });
});

// Design "Getting ready": the three things on screen.
test("getting ready: waiting view says the name once and 'This can take a minute.'", async () => {
  const { GettingReadyBody } = await bodyModule;
  const html = renderToStaticMarkup(createElement(GettingReadyBody, { name: "Amazon", onRetry() {}, view: { kind: "waiting" } }));
  const text = visibleText(html).replace(/\s+/g, " ");
  assert.match(text, /Getting Amazon ready…/);
  assert.match(text, /This can take a minute\./);
  assert.doesNotMatch(html, /<button/);
  assert.deepEqual(bannedCopyProblems(html), []);
});

test("getting ready: failed view has the sentence, 'Try again', and the server message only under 'What went wrong'", async () => {
  const { GettingReadyBody } = await bodyModule;
  const html = renderToStaticMarkup(
    createElement(GettingReadyBody, { name: "Amazon", onRetry() {}, view: { detail: "registry unreachable", kind: "failed" } })
  );
  const text = visibleText(html).replace(/\s+/g, " ");
  assert.match(text, /Amazon couldn't be set up\. Check that this computer is online, then try again\./);
  assert.match(html, />Try again</);
  assert.match(html, /<summary[^>]*>\s*What went wrong\s*<\/summary>\s*<p[^>]*>registry unreachable<\/p>/);
  assert.deepEqual(bannedCopyProblems(html), []);
});

test("getting ready: an unavailable catalog stops polling and offers retry", async () => {
  let checks = 0;
  const outcome = await getServiceReady(deps({
    check: async () => {
      checks += 1;
      return { state: "retry" };
    },
    needsInstall: false,
    sleep: async () => assert.fail("retry must not wait"),
  }));
  assert.equal(checks, 1);
  assert.equal(outcome.kind, "failed");
  assert.ok(outcome.kind === "failed");
  assert.match(outcome.detail, /Couldn't check/);
});
