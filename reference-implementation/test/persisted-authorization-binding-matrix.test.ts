// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import { requirePersistedGrantState } from "../server/auth.ts";

const GRANT_ID = "grt_binding_matrix";
const SUBJECT_ID = "owner_binding_matrix";
const CLIENT_ID = "client_binding_matrix";

const grant = {
  access_mode: "continuous",
  client: { client_id: CLIENT_ID },
  grant_id: GRANT_ID,
  issued_at: "2026-08-11T12:00:00Z",
  purpose_code: "https://pdpp.dev/purpose/personal_ai_assistant",
  source: { id: "https://source.example/binding-matrix", kind: "connector" },
  source_declaration: { version: "1.0.0" },
  streams: [{ fields: ["id"], instance_ids: ["cin_binding_matrix"], name: "items" }],
  subject: { id: SUBJECT_ID },
  version: "0.1.0",
};

function persistedRow() {
  return {
    client_id: CLIENT_ID,
    expires_at: null as string | null,
    grant_access_mode: "continuous",
    grant_client_id: CLIENT_ID,
    grant_expires_at: null as string | null,
    grant_id: GRANT_ID,
    grant_json: JSON.stringify(grant),
    grant_subject_id: SUBJECT_ID,
    persisted_grant_id: GRANT_ID,
    storage_binding_json: JSON.stringify({ connector_id: "binding_matrix" }),
    subject_id: SUBJECT_ID,
    token_kind: "client" as string,
  };
}

test("persisted grant and token binding columns fail independently", () => {
  assert.equal(requirePersistedGrantState(persistedRow()).grant.grant_id, GRANT_ID);

  const mutations: Array<[string, (row: ReturnType<typeof persistedRow>) => void, boolean]> = [
    ["persisted grant id", (row) => (row.persisted_grant_id = "grt_other"), true],
    ["grant subject", (row) => (row.grant_subject_id = "owner_other"), true],
    ["grant client", (row) => (row.grant_client_id = "client_other"), true],
    ["grant access mode", (row) => (row.grant_access_mode = "single_use"), true],
    ["grant expiry", (row) => (row.grant_expires_at = "2030-01-01T00:00:00Z"), true],
    ["token grant", (row) => (row.grant_id = "grt_other"), false],
    ["token subject", (row) => (row.subject_id = "owner_other"), false],
    ["token client", (row) => (row.client_id = "client_other"), false],
    ["token expiry", (row) => (row.expires_at = "not-a-timestamp"), false],
  ];

  for (const [label, mutate, isolateGrantColumnGuard] of mutations) {
    const row = persistedRow();
    if (isolateGrantColumnGuard) {
      row.token_kind = "owner";
    }
    mutate(row);
    assert.throws(
      () => requirePersistedGrantState(row),
      (error: unknown) => {
        assert.ok(error instanceof Error, label);
        assert.equal((error as Error & { code?: string }).code, "grant_invalid", label);
        return true;
      },
    );
  }
});
