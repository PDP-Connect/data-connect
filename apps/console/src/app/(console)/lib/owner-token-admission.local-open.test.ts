// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Intentionally open local development: neither the console nor the
 * reference server has `PDPP_OWNER_PASSWORD`, and the reference server runs
 * in its loopback posture, which admits owner routes without a session.
 *
 * The console does not decide this from its own missing password; the split
 * tests show the same console refusing when the AS holds a password. Here the
 * AS admits the request, so the owner bearer is available without a cookie,
 * as it was before.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { asRequest, installNextRequestMocks, recordFetches, startReference } from "./owner-token-admission.harness.ts";

type OwnerTokenModule = typeof import("./owner-token.ts");
type SettingsActions = typeof import("../settings/desktop-settings-actions.ts");

let reference: Awaited<ReturnType<typeof startReference>>;
let fetches: ReturnType<typeof recordFetches>;
let getOwnerToken: OwnerTokenModule["getOwnerToken"];
let loadAppConfigAction: SettingsActions["loadAppConfigAction"];
let saveAppConfigAction: SettingsActions["saveAppConfigAction"];

test.before(async () => {
  installNextRequestMocks(test);
  delete process.env.PDPP_OWNER_PASSWORD;
  // Loopback bind, no password: the reference server derives its open
  // local-dev posture itself (a hosted bind without a password refuses to boot).
  reference = await startReference({});
  ({ getOwnerToken } = await import("./owner-token.ts"));
  ({ loadAppConfigAction, saveAppConfigAction } = await import("../settings/desktop-settings-actions.ts"));
  fetches = recordFetches();
});

test.after(async () => {
  fetches.restore();
  await reference.stop();
});

test("local-open: the AS admits a cookie-less request, so the owner bearer is available", async () => {
  const token = await asRequest(null, () => getOwnerToken());
  assert.ok(token.length > 0);
  assert.ok(
    fetches.calls.some((url) => url === `${reference.asUrl}/owner/session`),
    "the console asked the AS instead of assuming it is open"
  );
});

test("local-open: read and mutation through the Server Actions work without a session", async () => {
  const initial = await asRequest(null, () => loadAppConfigAction());
  const saved = await asRequest(null, () => saveAppConfigAction({ ...initial, closeToTray: !initial.closeToTray }));
  assert.ok(saved.ok, saved.ok ? "" : saved.message);
  assert.equal(saved.config.closeToTray, !initial.closeToTray);
});
