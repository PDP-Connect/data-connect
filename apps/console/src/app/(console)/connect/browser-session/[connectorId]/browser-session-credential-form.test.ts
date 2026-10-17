// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import { resolveAuth } from "../../../../../../../../packages/connector-protocol/src/auth.ts";
import { resolveStaticSecretRunEnv } from "../../../../../../../../reference-implementation/server/stores/static-secret-run-credentials.ts";
import type { StaticSecretSetup } from "../../../lib/ref-client.ts";
import { browserCredentialSubmission } from "./browser-session-credential-form.ts";

const MISSING_PASSWORD_RE = /Reddit password is required/;
const SECRET_LEAK_RE = /secret-value|do-not-capture/;

const SETUP: StaticSecretSetup = {
  connector_id: "reddit",
  credential_capture: {
    description: "Reddit sign-in details",
    fields: [
      {
        autocomplete: "username",
        description: null,
        help_text: null,
        help_url: null,
        identity: false,
        label: "Reddit username",
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
        label: "Reddit password",
        name: "password",
        placeholder: null,
        required: true,
        secret: true,
        type: "password",
      },
    ],
    kind: "username_password",
    label: "Reddit sign-in details",
    required: true,
    submit_label: null,
  },
  credential_kind: "username_password",
  deployment_readiness: { blockers: [], guidance: null, state: "ready" },
  display_name: "Reddit",
  object: "static_secret_setup",
  validation: "synchronous",
};

function form(values: Record<string, string>): Pick<FormData, "get"> {
  return { get: (name: string) => values[name] ?? null };
}

test("a required credential capture reaches the first browser run without an interaction", async () => {
  const result = browserCredentialSubmission(
    SETUP,
    form({ username: "owner@example.test", password: "do-not-capture" }),
  );
  assert.ok(result?.ok);
  assert.deepEqual(JSON.parse(result.submission.secret), {
    password: "do-not-capture",
    username: "owner@example.test",
  });
  assert.deepEqual(result.submission.setupFields, {});
  const manifest = {
    setup: {
      modality: "static_secret",
      credential_capture: {
        kind: "username_password",
        fields: [
          {
            name: "username",
            type: "text",
            secret: true,
            env: ["REDDIT_USERNAME"],
          },
          {
            name: "password",
            type: "password",
            secret: true,
            env: ["REDDIT_PASSWORD"],
          },
        ],
      },
    },
  };
  const runEnv = await resolveStaticSecretRunEnv({
    connectorId: "reddit",
    connectorInstanceId: "cin_reddit",
    ownerSubjectId: "owner_test",
    sourceBinding: { kind: "browser_enrollment_shell" },
    credentialStore: {
      recoverSecret: async () => ({
        credentialKind: "username_password",
        secret: result.submission.secret,
      }),
    },
    manifest,
  });
  assert.deepEqual(runEnv, {
    REDDIT_USERNAME: "owner@example.test",
    REDDIT_PASSWORD: "do-not-capture",
  });
  const previousUsername = process.env.REDDIT_USERNAME;
  const previousPassword = process.env.REDDIT_PASSWORD;
  try {
    Object.assign(process.env, runEnv);
    let interactions = 0;
    await resolveAuth(
      { kind: "env", required: ["REDDIT_USERNAME", "REDDIT_PASSWORD"] },
      {
        connectorName: "reddit",
        sendInteraction: async () => {
          interactions += 1;
          throw new Error("unexpected credentials interaction");
        },
      },
    );
    assert.equal(interactions, 0);
  } finally {
    if (previousUsername === undefined) delete process.env.REDDIT_USERNAME;
    else process.env.REDDIT_USERNAME = previousUsername;
    if (previousPassword === undefined) delete process.env.REDDIT_PASSWORD;
    else process.env.REDDIT_PASSWORD = previousPassword;
  }
});

test("unchecked optional capture takes the no-secret path", () => {
  const optionalSetup = {
    ...SETUP,
    credential_capture: { ...SETUP.credential_capture, required: false },
  };
  assert.equal(
    browserCredentialSubmission(
      optionalSetup,
      form({
        username: "owner@example.test",
        password: "do-not-capture",
        remember_sign_in_details: "0",
      }),
    ),
    null,
  );
});

test("checked optional credentials reuse manifest validation and encrypted payload shape", () => {
  const result = browserCredentialSubmission(
    SETUP,
    form({
      username: "owner@example.test",
      password: "secret-value",
      remember_sign_in_details: "1",
    }),
  );
  assert.ok(result?.ok);
  assert.equal(result.submission.setupFields.username, undefined, "secret fields never become setup URL context");
  assert.equal(result.submission.setupFields.password, undefined, "secret fields never become setup URL context");
  assert.deepEqual(JSON.parse(result.submission.secret), {
    password: "secret-value",
    username: "owner@example.test",
  });
});

test("checked optional credentials fail before shell creation when a manifest field is missing", () => {
  const result = browserCredentialSubmission(
    SETUP,
    form({ username: "owner@example.test", remember_sign_in_details: "true" }),
  );
  assert.ok(result && !result.ok);
  assert.match(result.error, MISSING_PASSWORD_RE);
  assert.doesNotMatch(JSON.stringify(result), SECRET_LEAK_RE);
});
