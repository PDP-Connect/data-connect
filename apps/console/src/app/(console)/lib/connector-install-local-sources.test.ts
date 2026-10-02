// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { strict as assert } from "node:assert"
import { test } from "node:test"
import { parseConnectorLocalSourcesResponse } from "./connector-install-contract.ts"

test("local source contract preserves unsigned provenance, path, and selection", () => {
  const [source] = parseConnectorLocalSourcesResponse({
    data: [
      {
        connector_id: "https://registry.pdpp.dev/connectors/developer-fixture",
        connector_key: "developer-fixture",
        display_name: "Developer fixture",
        entrypoint_path: "dist/collection-profile.mjs",
        manifest_path: "profile/collection-profile.json",
        provenance: "developer-local-unsigned",
        selected: true,
        source_id: "local_fixture",
        source_path: "/work/developer-fixture",
        updated_at: "2026-09-16T00:00:00.000Z",
        version: "0.1.0",
      },
    ],
    object: "connector_install_local_sources",
  })

  assert.equal(source?.provenance, "developer-local-unsigned")
  assert.equal(source?.source_path, "/work/developer-fixture")
  assert.equal(source?.selected, true)
})

test("local source contract rejects verified or unsigned-unknown provenance", () => {
  assert.throws(
    () =>
      parseConnectorLocalSourcesResponse({
        data: [{ provenance: "verified-oci" }],
        object: "connector_install_local_sources",
      }),
    /provenance must identify an unsigned developer-local source/
  )
})
