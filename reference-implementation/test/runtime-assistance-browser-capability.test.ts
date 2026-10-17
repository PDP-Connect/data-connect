// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import { buildAssistanceRequestedDataFromInteraction, hasBrowserSurfaceStream } from "../runtime/index.ts";

test("OTP assistance uses host browser capability while preserving value entry without it", () => {
  const hostBrowserAvailable = hasBrowserSurfaceStream({
    PDPP_BROWSER_SURFACE_REMOTE_CDP_URL: "http://127.0.0.1:9222",
  });
  assert.equal(hostBrowserAvailable, true);

  const interaction = { kind: "otp", message: "Enter the verification code.", request_id: "int_otp" };
  const runSource = { id: "run_otp", kind: "connector" };
  const browserAssistance = buildAssistanceRequestedDataFromInteraction(interaction, runSource, {
    browserSurfaceAvailable: hostBrowserAvailable,
  });
  assert.equal(browserAssistance.owner_action, "operate_attachment");
  assert.deepEqual(browserAssistance.attachments, [{ kind: "browser_surface", role: "streaming_companion" }]);

  const valueAssistance = buildAssistanceRequestedDataFromInteraction(interaction, runSource, {
    browserSurfaceAvailable: hasBrowserSurfaceStream(undefined),
  });
  assert.equal(valueAssistance.owner_action, "provide_value");
  assert.equal(valueAssistance.attachments, undefined);
});
