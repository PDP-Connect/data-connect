// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const APP_DIR = fileURLToPath(new URL(".", import.meta.url));

// Hosted-UI surfaces the console must answer at their BARE path. A Next.js
// catch-all does not match the bare path, so each of these needs its own
// segment — the regression this file exists to catch.
//
// HOW each is served is deliberately not asserted: `/consent` is now a real
// console page (it renders the consent screen from the AS's challenge model),
// while `/device` and `/owner` still proxy to the server-rendered hosted UI.
// Both satisfy the same guarantee — the path resolves — so the test asserts
// the guarantee and lets the mechanism differ.
const ROOT_HOSTED_UI_ROUTES = ["consent", "device", "owner"] as const;

test("console answers every bare hosted-UI root path", () => {
  for (const route of ROOT_HOSTED_UI_ROUTES) {
    const segment = join(APP_DIR, route);
    const served = existsSync(join(segment, "route.ts")) || existsSync(join(segment, "page.tsx"));
    assert.equal(
      served,
      true,
      `apps/console must expose /${route} as a route handler or a page; catch-all routes do not match the bare path`
    );
  }
});

test("consent is a console page, not a proxy to the server-rendered picker", () => {
  // The consent decision moved into the console (Ory-Hydra login-and-consent
  // shape): the AS parks the authorize request under a challenge and redirects
  // here, and this page renders it. A `route.ts` reappearing under /consent
  // would mean the proxy came back and the console page stopped being the
  // surface the owner actually sees.
  assert.equal(
    existsSync(join(APP_DIR, "consent", "page.tsx")),
    true,
    "/consent must be a console page"
  );
  assert.equal(
    existsSync(join(APP_DIR, "consent", "route.ts")),
    false,
    "/consent must not also be a proxy route; the page is the consent surface"
  );
});
