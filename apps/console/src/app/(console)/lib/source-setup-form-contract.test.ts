// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import type { StaticSecretSetup } from "./ref-client.ts";
import {
  browserSessionFormContract,
  browserCredentialFieldLabel,
  connectionNameFieldContract,
  staticSecretFormContract,
} from "./source-setup-form-contract.ts";

const INTERACTIVE_SIGN_IN_RE = /Interactive sign-in is valid/;
const LEAVE_FIELDS_BLANK_RE = /Leave these fields blank/;
const UNATTENDED_RECONNECTION_RE = /unattended reconnection is not guaranteed/;
const NO_PROVIDER_CREDENTIALS_RE = /does not collect provider credentials/;
const NO_UNATTENDED_RECONNECTION_RE = /does not promise unattended reconnection/;
const AUTOMATIC_LOGIN_RE = /automatic login/i;

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

test("connection-name contract is app-owned and shared across source forms", () => {
  assert.deepEqual(connectionNameFieldContract("Synthetic source"), {
    helpText: "Used only when creating a new source. You can rename it later.",
    label: "Connection name (optional)",
    maxLength: 200,
    name: "display_name",
    placeholder: "Synthetic source personal",
  });
});

test("required browser credential capture uses manifest labels without an optional sign-in claim", () => {
  const contract = browserSessionFormContract(SETUP);
  assert.ok(contract.credentialCapture);
  assert.equal(contract.credentialCapture.required, true);
  assert.equal(contract.credentialCapture.title, SETUP.credential_capture.label);
  assert.doesNotMatch(contract.setupDescription, INTERACTIVE_SIGN_IN_RE);
  const usernameField = SETUP.credential_capture.fields.find((field) => field.name === "username");
  assert.ok(usernameField);
  assert.equal(browserCredentialFieldLabel(usernameField, true), "Username");
  assert.deepEqual(contract.credentialCapture.fields, SETUP.credential_capture.fields);
  assert.match(contract.credentialCapture.description, /^Manifest-authored sign-in details\. /);
  assert.match(contract.credentialCapture.description, /stores these details encrypted on this device/);
});

test("optional browser credential capture keeps the opt-in and browser sign-in path", () => {
  const optionalSetup = {
    ...SETUP,
    credential_capture: { ...SETUP.credential_capture, required: false },
  };
  const contract = browserSessionFormContract(optionalSetup);
  assert.ok(contract.credentialCapture);
  assert.equal(contract.credentialCapture.required, false);
  assert.match(contract.setupDescription, INTERACTIVE_SIGN_IN_RE);
  assert.match(contract.credentialCapture.description, LEAVE_FIELDS_BLANK_RE);
  assert.match(contract.credentialCapture.description, UNATTENDED_RECONNECTION_RE);
  assert.equal(browserCredentialFieldLabel(optionalSetup.credential_capture.fields[0]!, false), "Username (optional)");
});

test("browser-only start has no optional credential section or automatic-login promise", () => {
  const contract = browserSessionFormContract(null);
  assert.equal(contract.credentialCapture, null);
  assert.match(contract.setupDescription, NO_PROVIDER_CREDENTIALS_RE);
  assert.match(contract.setupDescription, NO_UNATTENDED_RECONNECTION_RE);
  assert.doesNotMatch(contract.setupDescription, AUTOMATIC_LOGIN_RE);
});

test("static-secret form keeps manifest fields and submit label while adding the shared name field", () => {
  const contract = staticSecretFormContract(SETUP, false);
  assert.equal(contract.connectionName.name, "display_name");
  assert.deepEqual(contract.credentialFields, SETUP.credential_capture.fields);
  assert.equal(contract.primaryActionLabel, "Save details");
  assert.equal(staticSecretFormContract(SETUP, true).primaryActionLabel, "Reconnect account and run sync");
});
