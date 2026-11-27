// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import type { StaticSecretSetup } from "./ref-client.ts";
import { browserSignInCapture } from "./source-setup-form-contract.ts";

const SETUP: StaticSecretSetup = {
  connector_id: "synthetic-browser-source",
  credential_capture: {
    description: "Manifest-authored sign-in details.",
    fields: [
      {
        autocomplete: "username",
        description: null,
        help_text: null,
        help_url: null,
        identity: false,
        label: "Username",
        name: "username",
        placeholder: null,
        required: true,
        secret: true,
        type: "text",
      },
      {
        autocomplete: "current-password",
        description: null,
        help_text: null,
        help_url: null,
        identity: false,
        label: "Password",
        name: "password",
        placeholder: null,
        required: true,
        secret: true,
        type: "password",
      },
    ],
    kind: "username_password",
    label: "Sign-in details",
    required: true,
    submit_label: "Save details",
  },
  credential_kind: "username_password",
  deployment_readiness: { blockers: [], guidance: null, state: "ready" },
  display_name: "Synthetic browser source",
  object: "static_secret_setup",
  validation: "first_sync",
};

// Design "Sign-in services": required details show their fields; optional details are an opt-in; none means no fields.
test("required browser sign-in details use the manifest's own fields", () => {
  const capture = browserSignInCapture(SETUP);
  assert.ok(capture);
  assert.equal(capture.required, true);
  assert.equal(capture.checkboxName, "remember_sign_in_details");
  assert.deepEqual(capture.fields, SETUP.credential_capture.fields);
});

test("optional browser sign-in details stay an opt-in", () => {
  const capture = browserSignInCapture({
    ...SETUP,
    credential_capture: { ...SETUP.credential_capture, required: false },
  });
  assert.ok(capture);
  assert.equal(capture.required, false);
});

test("browser-only start has no sign-in details section", () => {
  assert.equal(browserSignInCapture(null), null);
});
