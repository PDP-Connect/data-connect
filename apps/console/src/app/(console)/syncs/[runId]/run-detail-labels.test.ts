// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Regression guard: the run-detail assistance/stats callouts used to print raw
 * internal enum strings and snake_case field names straight into owner-facing
 * UI (`blocked · provide_value · response_required`, `commit_failed`). These
 * helpers are the only path to that UI now, so pinning them pins the fix.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  describeAssistanceOwnerAction,
  describeAssistanceProgressPosture,
  describeAssistanceResponseContract,
  describeCheckpointStatLabel,
  describeInteractionStatLabel,
  describeProgressStatLabel,
  describeTerminalRunStatus,
  resolveRunConnectionId,
} from "./run-detail-labels.ts";

test("assistance progress posture never leaks the raw snake_case value", () => {
  assert.equal(describeAssistanceProgressPosture("blocked"), "Blocked");
  assert.equal(describeAssistanceProgressPosture("running"), "Running");
  assert.equal(describeAssistanceProgressPosture("waiting_retry"), "Waiting to retry");
});

test("assistance owner action never leaks the raw snake_case value", () => {
  assert.equal(describeAssistanceOwnerAction("provide_value"), "Needs a value from you");
  assert.equal(describeAssistanceOwnerAction("operate_attachment"), "Needs you to complete a step");
  assert.equal(describeAssistanceOwnerAction("act_elsewhere"), "Approve outside this dashboard");
  assert.equal(describeAssistanceOwnerAction("none"), "No action needed");
});

test("assistance response contract never leaks the raw snake_case value", () => {
  assert.equal(describeAssistanceResponseContract("response_required"), "Response required");
  assert.equal(describeAssistanceResponseContract("none"), "No response required");
});

test("terminal run status humanizes succeeded_with_gaps instead of passing it through raw", () => {
  assert.equal(describeTerminalRunStatus("succeeded_with_gaps"), "succeeded with gaps");
  assert.equal(describeTerminalRunStatus("succeeded"), "succeeded");
  assert.equal(describeTerminalRunStatus("failed"), "failed");
  assert.equal(describeTerminalRunStatus("cancelled"), "cancelled");
  assert.equal(describeTerminalRunStatus("deferred"), "deferred");
});

test("stat-card row labels are Title Case, not the raw field name", () => {
  assert.equal(describeCheckpointStatLabel("commit_failed"), "Failed to commit");
  assert.equal(describeCheckpointStatLabel("staged"), "Staged");
  assert.equal(describeCheckpointStatLabel("advanced"), "Advanced");
  assert.equal(describeProgressStatLabel("last_message"), "Last message");
  assert.equal(describeProgressStatLabel("last_count"), "Last count");
  assert.equal(describeProgressStatLabel("last_total"), "Last total");
  assert.equal(describeProgressStatLabel("reports"), "Reports");
  // Named in its unit: the stat counts `run.stream_skipped` events, which a
  // connector emits per dropped RECORD. A bare "Skipped" next to a number
  // read as a stream count.
  assert.equal(describeProgressStatLabel("skipped"), "Skipped items");
  assert.equal(describeInteractionStatLabel("required"), "Required");
  assert.equal(describeInteractionStatLabel("completed"), "Completed");
});

test("run status connection id wins over legacy aliases and event ids", () => {
  assert.equal(
    resolveRunConnectionId({ connection_id: "cin_status", connector_instance_id: "cin_legacy" }, [
      { data: { connection_id: "cin_event" } },
    ]),
    "cin_status"
  );
  assert.equal(
    resolveRunConnectionId({ connector_instance_id: "cin_status_legacy" }, [{ data: { connection_id: "cin_event" } }]),
    "cin_status_legacy"
  );
});

test("event fallback uses the first valid id and prefers its canonical field", () => {
  assert.equal(
    resolveRunConnectionId(null, [
      { data: { message: "started" } },
      { data: { connection_id: "cin_first", connector_instance_id: "cin_alias" } },
      { data: { connection_id: "cin_later" } },
    ]),
    "cin_first"
  );
  assert.equal(
    resolveRunConnectionId({}, [
      { data: { connector_instance_id: "cin_legacy" } },
      { data: { connection_id: "cin_later" } },
    ]),
    "cin_legacy"
  );
});

test("invalid ids are skipped without treating a connector as a connection", () => {
  for (const invalid of [undefined, null, 42, false, {}, [], "", "  "]) {
    assert.equal(
      resolveRunConnectionId({ connection_id: invalid }, [
        { data: { connection_id: invalid } },
        { data: { connector_instance_id: "cin_fallback" } },
      ]),
      "cin_fallback"
    );
  }
  assert.equal(resolveRunConnectionId({ connection_id: "", connector_instance_id: "cin_alias" }, []), "cin_alias");
  assert.equal(resolveRunConnectionId(null, []), null);
  assert.equal(
    resolveRunConnectionId({ connector_id: "chatgpt" }, [
      {},
      { data: null },
      { data: [] },
      { data: "cin_not_a_record" },
      { data: { actor_id: "chatgpt", connector_id: "chatgpt" } },
    ]),
    null
  );
});

test("connection ids remain opaque strings, with surrounding whitespace removed", () => {
  assert.equal(resolveRunConnectionId({ connection_id: "  cin/a ?#%  " }, []), "cin/a ?#%");
});
