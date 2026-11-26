// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import test from "node:test";
import type { AppAccess as Registration } from "../lib/ref-client.ts";
import { groupGrantAccessByApp, UNKNOWN_APP_NAME } from "./app-access.ts";
function registration(id = "one", patch: Partial<Registration> = {}): Registration {
  return { client_id: id, client_name: "ChatGPT", return_host: "chatgpt.com", returns_to_this_computer: false, domain_control_verified: true, reads_last_7_days: 0,
    sources: [{ source: { kind: "connector", id: "gmail", connector_id: "gmail", connection_id: "mail" }, kinds: ["messages"], in_force: true, first_issued_at: "2026-01-01T00:00:00Z", expires_at: null, stopped_at: null, stopped_reason: null, last_read_at: null, grant_ids: [id], active_grant_ids: [id], package_ids: [] }], ...patch };
}
test("same name AND return host merge, preserving every old permission address", () => {
  const rows = groupGrantAccessByApp([registration(), registration("two"), registration("three", { return_host: "lookalike.example" })]);
  assert.equal(rows.length, 2); assert.deepEqual(rows[0]?.grantIds, ["one", "two"]); assert.equal(rows[0]?.sourceAccess.length, 1);
  assert.ok(rows.find((app) => app.grantIds.includes("two"))?.clientIds.includes("two"));
});
test("loopback shares this computer; missing address groups by name; fully unnamed stands alone", () => {
  const rows = groupGrantAccessByApp([registration("a", { returns_to_this_computer: true, return_host: "localhost" }), registration("b", { returns_to_this_computer: true, return_host: "127.0.0.1" }), registration("c", { return_host: null }), registration("d", { return_host: null }), registration("e", { client_name: "", return_host: null }), registration("f", { client_name: "", return_host: null }), registration("g", { client_name: "" })]);
  assert.equal(rows.length, 5); assert.equal(rows.filter((row) => row.name === UNKNOWN_APP_NAME).length, 2); assert.ok(rows.some((row) => row.name === "chatgpt.com"));
});
test("expiry overrides in force; an event outcome is never an input", () => {
  const item = registration(); item.sources[0]!.expires_at = "2026-01-02T00:00:00Z";
  assert.equal(groupGrantAccessByApp([item], Date.parse("2026-01-03"))[0]?.state, "stopped");
  item.sources[0]!.expires_at = null; assert.equal(groupGrantAccessByApp([item])[0]?.state, "reading");
  item.sources[0]!.in_force = false; assert.equal(groupGrantAccessByApp([item])[0]?.state, "stopped");
});
test("every merged registration must be verified; kinds union without mutating input", () => {
  const a = registration(); const b = registration("two", { domain_control_verified: false }); b.sources[0]!.kinds = ["threads"];
  const before = structuredClone([a, b]); const app = groupGrantAccessByApp([a, b])[0]!;
  assert.equal(app.verified, false); assert.deepEqual(app.sourceAccess[0]?.kinds, ["messages", "threads"]); assert.deepEqual([a, b], before);
});
