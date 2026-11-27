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

// Sign-in instructions are long. They keep their own length bound (2,000), not the
// 200-character diagnostic-gap bound, and redaction is applied exactly as before.
test("a 600-character sign-in instruction is kept whole and still redacted", () => {
  const instruction = `${"Complete the security check in the secure browser, then continue. ".repeat(9)}Use password: hunter2 and open https://example.com/private?x=1 code 123456 now.`;
  assert.ok(instruction.length > 600);
  const data = buildAssistanceRequestedDataFromInteraction(
    { kind: "manual_action", message: instruction, request_id: "int_long" },
    { id: "run_long", kind: "connector" }
  );
  const message = String(data.message);
  assert.ok(message.length > 600, `kept ${message.length} characters`);
  assert.ok(message.startsWith("Complete the security check"));
  assert.ok(message.includes("password=[REDACTED]"), "secret still redacted");
  assert.ok(message.includes("[REDACTED_URL]"), "url still redacted");
  assert.ok(message.includes("[REDACTED_OTP]"), "six-digit code still redacted");
  assert.ok(!/hunter2|example\.com|123456/.test(message));
  const huge = buildAssistanceRequestedDataFromInteraction(
    { kind: "manual_action", message: "x".repeat(5000), request_id: "int_huge" },
    { id: "run_huge", kind: "connector" }
  );
  assert.equal(String(huge.message).length, 2000);
});
