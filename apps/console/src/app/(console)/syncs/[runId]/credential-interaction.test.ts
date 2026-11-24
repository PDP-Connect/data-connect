// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict"
import test from "node:test"
import type { StaticSecretSetup } from "../../lib/ref-client.ts"
import { projectCredentialInteraction } from "./credential-interaction.ts"

const SETUP = {
  credential_capture: {
    fields: [
      {
        name: "username",
        label: "Reddit username",
        type: "text",
        secret: true,
        autocomplete: "username",
        env: ["REDDIT_USERNAME"],
      },
      {
        name: "password",
        label: "Reddit password",
        type: "password",
        secret: true,
        autocomplete: "current-password",
        env: ["REDDIT_PASSWORD"],
      },
    ],
    submit_label: "Save Reddit credential and start first sync",
  },
} as StaticSecretSetup

test("missing-env form follows manifest labels, field order, input types, autocomplete, and submit label", () => {
  const view = projectCredentialInteraction(
    [
      {
        name: "REDDIT_PASSWORD",
        label: null,
        format: "password",
        required: true,
      },
      { name: "REDDIT_USERNAME", label: null, format: "text", required: true },
    ],
    SETUP
  )
  assert.deepEqual(view.fields, [
    {
      name: "REDDIT_USERNAME",
      label: "Reddit username",
      format: "text",
      autocomplete: "username",
      required: true,
    },
    {
      name: "REDDIT_PASSWORD",
      label: "Reddit password",
      format: "password",
      autocomplete: "current-password",
      required: true,
    },
  ])
  assert.equal(view.submitLabel, SETUP.credential_capture.submit_label)
  assert.doesNotMatch(view.message, /REDDIT_(?:USERNAME|PASSWORD)/)
})

test("unmatched env fields have readable labels and keep schema order", () => {
  const view = projectCredentialInteraction(
    [
      {
        name: "SERVICE_API_TOKEN",
        label: null,
        format: "password",
        required: true,
      },
      { name: "SECOND_FIELD", label: null, format: "text", required: false },
    ],
    null
  )
  assert.deepEqual(
    view.fields.map(field => field.label),
    ["Service API token", "Second field"]
  )
  assert.deepEqual(
    view.fields.map(field => field.name),
    ["SERVICE_API_TOKEN", "SECOND_FIELD"]
  )
  assert.doesNotMatch(view.message, /SERVICE_API_TOKEN|SECOND_FIELD/)
})
