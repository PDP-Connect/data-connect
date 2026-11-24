// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for the `revokeConnection` / `deleteConnection` /
 * `pauseConnection` / `resumeConnection` client-wrapper outcome mappings.
 *
 * The pure `(status, body, code)` → outcome classifiers live in
 * `connection-control-result.ts` (not `operator-runs.ts`) specifically so they
 * can be imported and executed under `node --test`: `operator-runs.ts`
 * transitively imports `owner-token.ts`, which does `import "server-only"` and
 * throws outside the React Server runtime. We unit-test the classifiers directly.
 * Wrapper requests run separately through `operator-runs-wire.behavior.test.ts`,
 * including browser-profile purge.
 *
 * Outcomes under test (tasks 2.1 / 2.2):
 *   Revoke: 200 → revoked; 400 connector_instance_inactive → already_revoked;
 *           else → typed thrown Error.
 *   Delete: 200 → deleted (+ record count); 409 connection_run_active →
 *           run_active; 409 default_account_delete_unsupported →
 *           default_account; 404 connector_instance_not_found → not_found;
 *           else → typed thrown Error.
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyBrowserProfilePurgeResponse,
  classifyDeleteConnectionResponse,
  classifyPauseConnectionResponse,
  classifyResumeConnectionResponse,
  classifyRevokeConnectionResponse,
  connectionControlErrorCode,
  profilePurgeSentence,
} from "./connection-control-result.ts";

const REVOKE_THROWS_RE = /nope|connection revoke failed/;
const DELETE_THROWS_RE = /boom|connection delete failed/;
const PAUSE_THROWS_RE = /nope|connection pause failed/;
const RESUME_THROWS_RE = /nope|connection resume failed/;

const FAILED_PURGE = {
  error_code: "profile_purge_in_use",
  message: "Refused to remove saved session: a browser is still using it.",
  status: "failed",
};

test("revoke 200 maps to revoked", () => {
  assert.deepEqual(classifyRevokeConnectionResponse(200, { status: "revoked" }, null), { status: "revoked" });
});

test("revoke 400 connector_instance_inactive maps to already_revoked", () => {
  const body = { error: { code: "connector_instance_inactive", message: "already revoked" } };
  assert.deepEqual(classifyRevokeConnectionResponse(400, body, connectionControlErrorCode(body)), {
    status: "already_revoked",
  });
});

test("revoke on an unexpected status throws a described error", () => {
  const body = { error: { code: "permission_error", message: "nope" } };
  assert.throws(() => classifyRevokeConnectionResponse(403, body, connectionControlErrorCode(body)), REVOKE_THROWS_RE);
});

test("delete 200 maps to deleted and carries the record count", () => {
  assert.deepEqual(classifyDeleteConnectionResponse(200, { deleted: true, deleted_record_count: 42 }, null), {
    deletedRecordCount: 42,
    status: "deleted",
  });
});

test("delete 200 without a record count still maps to deleted", () => {
  assert.deepEqual(classifyDeleteConnectionResponse(200, { deleted: true }, null), { status: "deleted" });
});

test("delete 409 connection_run_active maps to run_active", () => {
  const body = { error: { code: "connection_run_active", message: "a run is active" } };
  assert.deepEqual(classifyDeleteConnectionResponse(409, body, connectionControlErrorCode(body)), {
    status: "run_active",
  });
});

test("delete 409 connection_run_active carries the blocking run id", () => {
  const body = { error: { active_run_id: "run_42", code: "connection_run_active", message: "a run is active" } };
  assert.deepEqual(classifyDeleteConnectionResponse(409, body, connectionControlErrorCode(body)), {
    activeRunId: "run_42",
    status: "run_active",
  });
});

test("delete 409 default_account_delete_unsupported maps to default_account", () => {
  const body = { error: { code: "default_account_delete_unsupported", message: "revoke instead" } };
  assert.deepEqual(classifyDeleteConnectionResponse(409, body, connectionControlErrorCode(body)), {
    status: "default_account",
  });
});

test("delete 404 connector_instance_not_found maps to not_found", () => {
  const body = { error: { code: "connector_instance_not_found", message: "unknown" } };
  assert.deepEqual(classifyDeleteConnectionResponse(404, body, connectionControlErrorCode(body)), {
    status: "not_found",
  });
});

test("delete on an unexpected status throws a described error", () => {
  const body = { error: { code: "api_error", message: "boom" } };
  assert.throws(() => classifyDeleteConnectionResponse(500, body, connectionControlErrorCode(body)), DELETE_THROWS_RE);
});

test("connectionControlErrorCode tolerates malformed bodies", () => {
  assert.equal(connectionControlErrorCode(null), null);
  assert.equal(connectionControlErrorCode("not json"), null);
  assert.equal(connectionControlErrorCode({ error: "string" }), null);
  assert.equal(connectionControlErrorCode({ error: { code: 7 } }), null);
  assert.equal(connectionControlErrorCode({ error: { code: "x" } }), "x");
});

test("pause maps 200 to paused", () => {
  assert.deepEqual(classifyPauseConnectionResponse(200, { object: "owner_connection_pause" }, null), {
    status: "paused",
  });
});

test("pause maps 409 connector_instance_not_active to not_active", () => {
  const body = { error: { code: "connector_instance_not_active" } };
  assert.deepEqual(classifyPauseConnectionResponse(409, body, connectionControlErrorCode(body)), {
    status: "not_active",
  });
});

test("pause maps 404 connector_instance_not_found to not_found", () => {
  const body = { error: { code: "connector_instance_not_found" } };
  assert.deepEqual(classifyPauseConnectionResponse(404, body, connectionControlErrorCode(body)), {
    status: "not_found",
  });
});

test("pause on an unexpected status throws a described error", () => {
  const body = { error: { code: "api_error", message: "nope" } };
  assert.throws(() => classifyPauseConnectionResponse(500, body, connectionControlErrorCode(body)), PAUSE_THROWS_RE);
});

test("resume maps 200 to resumed", () => {
  assert.deepEqual(classifyResumeConnectionResponse(200, { object: "owner_connection_resume" }, null), {
    status: "resumed",
  });
});

test("resume maps 409 connector_instance_not_paused to not_paused", () => {
  const body = { error: { code: "connector_instance_not_paused" } };
  assert.deepEqual(classifyResumeConnectionResponse(409, body, connectionControlErrorCode(body)), {
    status: "not_paused",
  });
});

test("resume maps 404 connector_instance_not_found to not_found", () => {
  const body = { error: { code: "connector_instance_not_found" } };
  assert.deepEqual(classifyResumeConnectionResponse(404, body, connectionControlErrorCode(body)), {
    status: "not_found",
  });
});

test("resume on an unexpected status throws a described error", () => {
  const body = { error: { code: "api_error", message: "nope" } };
  assert.throws(() => classifyResumeConnectionResponse(500, body, connectionControlErrorCode(body)), RESUME_THROWS_RE);
});

test("delete 200 carries a failed profile_purge", () => {
  assert.deepEqual(
    classifyDeleteConnectionResponse(200, { deleted_record_count: 3, profile_purge: FAILED_PURGE }, null),
    {
      deletedRecordCount: 3,
      profilePurge: { errorCode: "profile_purge_in_use", message: FAILED_PURGE.message, status: "failed" },
      status: "deleted",
    }
  );
});

test("revoke 200 carries the profile_purge and ignores a malformed one", () => {
  assert.deepEqual(classifyRevokeConnectionResponse(200, { profile_purge: FAILED_PURGE }, null).profilePurge?.status, "failed");
  assert.deepEqual(classifyRevokeConnectionResponse(200, { profile_purge: { status: "bogus" } }, null), {
    status: "revoked",
  });
});

test("the banner sentence names a failed purge and stays silent otherwise", () => {
  assert.equal(
    profilePurgeSentence({ message: "a browser is still using it", status: "failed" }),
    "The saved browser session could not be removed (a browser is still using it)."
  );
  assert.equal(profilePurgeSentence({ status: "purged" }), null);
  assert.equal(profilePurgeSentence({ status: "absent" }), null);
  assert.equal(profilePurgeSentence(undefined), null);
});

test("the purge retry maps 200, 409 connection_not_removed and 404, and throws otherwise", () => {
  assert.deepEqual(classifyBrowserProfilePurgeResponse(200, { profile_purge: { status: "purged" } }, null), {
    profilePurge: { status: "purged" },
    status: "purge_reported",
  });
  assert.deepEqual(classifyBrowserProfilePurgeResponse(409, {}, "connection_not_removed"), { status: "not_removed" });
  assert.deepEqual(classifyBrowserProfilePurgeResponse(404, {}, "connector_instance_not_found"), {
    status: "not_found",
  });
  assert.throws(() => classifyBrowserProfilePurgeResponse(500, {}, null));
});
