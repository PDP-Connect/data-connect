// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// node --test reconcile.test.ts   (pure parts; the SQL is exercised against
// the seeded load-test database, see README.md)

import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { exportTokenRef, toCsv } from "./export-audit.ts";
import { evaluate, readExternalCount, type SpineCounts } from "./reconcile.ts";

const spine: SpineCounts = {
  consent_refusals: 0,
  denials_by_reason: { grant_revoked: 2, not_found: 1, token_unknown: 1 },
  denials_total: 4,
  records_served: 10,
  requests: 14,
  served_after_revocation: 0,
  served_after_revocation_max_lag_s: null,
  served_reads: 10,
  unresolved_requests: 0,
};

test("external counts: literal, json field, array, jsonl, csv", async () => {
  const dir = mkdtempSync(join(tmpdir(), "vacuna-reconcile-"));
  writeFileSync(join(dir, "gw.json"), JSON.stringify({ accepted: 10, rejected: 3 }));
  writeFileSync(join(dir, "count.json"), JSON.stringify({ count: 7 }));
  writeFileSync(join(dir, "list.json"), JSON.stringify([1, 2, 3]));
  writeFileSync(join(dir, "receipts.jsonl"), '{"r":1}\n{"r":2}\n\n');
  writeFileSync(join(dir, "received.csv"), "child,at\nA,1\nB,2\n");
  assert.equal((await readExternalCount("42")).count, 42);
  assert.equal((await readExternalCount(join(dir, "gw.json"), "accepted")).count, 10);
  assert.equal((await readExternalCount(join(dir, "count.json"))).count, 7);
  assert.equal((await readExternalCount(join(dir, "list.json"))).count, 3);
  assert.equal((await readExternalCount(join(dir, "receipts.jsonl"))).count, 2);
  assert.equal((await readExternalCount(join(dir, "received.csv"))).count, 2);
  await assert.rejects(readExternalCount(join(dir, "gw.json"), "missing"), /not a number/);
});

test("passes only when all four paid-read counts agree", () => {
  const same = { count: 10, source: "x" };
  assert.ok(
    evaluate(spine, { gateway_accepted: same, register_receipts: same, reminder_received: same }).every((c) => c.pass)
  );
  const checks = evaluate(spine, {
    gateway_accepted: same,
    register_receipts: same,
    reminder_received: { count: 9, source: "y" },
  });
  assert.equal(checks[0]?.pass, false);
  assert.match(checks[0]?.detail ?? "", /reminder_received=9/);
});

test("fails on unaudited outcomes and on reads after revocation", () => {
  const same = { count: 10, source: "x" };
  const ext = { gateway_accepted: same, register_receipts: same, reminder_received: same };
  assert.equal(evaluate({ ...spine, unresolved_requests: 1 }, ext)[1]?.pass, false);
  assert.equal(evaluate({ ...spine, requests: 15 }, ext)[1]?.pass, false);
  assert.equal(
    evaluate({ ...spine, served_after_revocation: 1, served_after_revocation_max_lag_s: 0.2 }, ext)[2]?.pass,
    false
  );
});

test("csv export quotes cells that need it", () => {
  const csv = toCsv([{ child_record_id: "DR-1", outcome: "denied", reason: 'a,"b"' }]);
  const [header, row] = csv.trim().split("\n");
  assert.ok(header?.startsWith("occurred_at,child_record_id,outcome,reason"));
  assert.equal(row, ',DR-1,denied,"a,""b""",,,,,,,');
});

test("csv export never copies a raw bearer", () => {
  assert.equal(exportTokenRef("tkh_abc"), "tkh_abc");
  assert.equal(exportTokenRef("f".repeat(64)), "unhashed-legacy-row");
  assert.equal(exportTokenRef(null), null);
});
