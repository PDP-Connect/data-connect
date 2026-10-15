// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Walkthrough deployment pieces that need no server:
//   node --test scripts/demo-dr-vacuna/portal/portal.test.ts

import assert from "node:assert/strict";
import test from "node:test";
import { isPublicAsPath } from "./public-paths.ts";
import { ADULTS, CHILDREN, GUARDIANSHIPS, REFERENCE_DATE, walkthroughRecord } from "./walkthrough-data.ts";

test("public listener forwards only the browser's AS paths", () => {
  for (const [method, path] of [
    ["GET", "/pilot/vacuna"],
    ["POST", "/pilot/cuenta-unica/login"],
    ["POST", "/pilot/vacuna/autorizaciones/grt_1/revoke"],
    ["GET", "/oauth/authorize"],
    ["GET", "/consent"],
    ["GET", "/.well-known/oauth-authorization-server"],
  ] as const) {
    assert.equal(isPublicAsPath(method, path), true, `${method} ${path}`);
  }
  for (const [method, path] of [
    ["POST", "/pilot/vacuna/grant-lifecycle"],
    ["POST", "/oauth/token"],
    ["POST", "/oauth/par"],
    ["POST", "/oauth/register"],
    ["POST", "/oauth/device_authorization"],
    ["POST", "/device/approve"],
    ["POST", "/consent/approve"],
    ["POST", "/connectors"],
    ["GET", "/grants"],
    ["GET", "/owner/login"],
    ["POST", "/introspect"],
  ] as const) {
    assert.equal(isPublicAsPath(method, path), false, `${method} ${path}`);
  }
});

test("walkthrough data is consistent and covers each story", () => {
  const cedulas = new Set(ADULTS.map((a) => a.cedula));
  const childIds = new Set(CHILDREN.map((c) => c.child_id));
  assert.equal(cedulas.size, ADULTS.length);
  assert.equal(childIds.size, CHILDREN.length);
  for (const a of ADULTS) {
    assert.match(a.cedula, /^\d{11}$/);
  }
  for (const g of GUARDIANSHIPS) {
    assert.ok(cedulas.has(g.cedula), g.cedula);
    assert.ok(childIds.has(g.child_id), g.child_id);
  }
  const childrenOf = (cedula: string) => GUARDIANSHIPS.filter((g) => g.cedula === cedula && g.status === "active");
  assert.equal(childrenOf("00100000011").length, 1, "María: one child");
  assert.equal(childrenOf("00100000022").length, 2, "Carmen: two children");
  const diegoParents = GUARDIANSHIPS.filter((g) => g.child_id === "DR-9100004").map((g) => g.cedula);
  assert.deepEqual(diegoParents.sort(), ["00100000033", "00100000044"], "Juan and Rosa share Diego");
  assert.ok(childrenOf("00100000055").every((g) => g.capacity === "legal_guardian"), "Ramón is a legal guardian");
  assert.equal(childrenOf("00100000066").length, 0, "Pedro has no active authority");
  const miguel = CHILDREN.find((c) => c.child_id === "DR-9100008");
  const turns18 = Date.parse(`${Number(miguel?.birth_date.slice(0, 4)) + 18}${miguel?.birth_date.slice(4)}T00:00:00Z`);
  const days = (turns18 - Date.parse(`${REFERENCE_DATE}T00:00:00Z`)) / 86_400_000;
  assert.ok(days > 0 && days < 120, "Miguel turns 18 within a few months of the reference date");
});

test("records: Sofía's next dose is days away, Ana is overdue, deterministic", () => {
  const sofia = walkthroughRecord(CHILDREN[0] as (typeof CHILDREN)[number]);
  assert.deepEqual(sofia.next_dose_due, { due_date: "2026-10-18", dose_number: 2, vaccine: "Pentavalente" });
  const ana = walkthroughRecord(CHILDREN.find((c) => c.child_id === "DR-9100003") as (typeof CHILDREN)[number]);
  assert.equal(ana.next_dose_due?.vaccine, "Pentavalente");
  assert.ok((ana.next_dose_due?.due_date ?? "") < REFERENCE_DATE);
  assert.deepEqual(walkthroughRecord(CHILDREN[0] as (typeof CHILDREN)[number]), sofia);
  for (const child of CHILDREN) {
    const record = walkthroughRecord(child);
    assert.ok(record.doses.every((d) => d.date <= REFERENCE_DATE && d.date >= child.birth_date), child.child_id);
  }
});

test("dashboard links a settled payment to the explorer by its transaction hash", async () => {
  const { explorerTxBase, txHashOf } = await import("./reminder-web.ts");
  const hash = `0x${"ab".repeat(32)}`;
  assert.equal(txHashOf(JSON.stringify({ success: true, txHash: hash })), hash);
  assert.equal(txHashOf(JSON.stringify({ result: { transaction_hash: hash } })), hash);
  assert.equal(txHashOf(JSON.stringify({ success: true })), null);
  assert.equal(txHashOf("not json"), null);
  assert.match(explorerTxBase(), /^https:\/\/.+\/tx\/$/);
});

test("payer env file: fills unset settings, never holds private keys", async () => {
  const { mkdtempSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { loadPayerEnvFile } = await import("./reminder-web.ts");
  const dir = mkdtempSync(join(tmpdir(), "vacuna-env-"));
  const file = join(dir, "moksha.env");
  writeFileSync(file, "# from the Moksha registration\nVACUNA_TEST_ESCROW=0xabc\nVACUNA_TEST_KEEP=from-file\n");
  process.env.VACUNA_TEST_KEEP = "from-env";
  loadPayerEnvFile(file);
  assert.equal(process.env.VACUNA_TEST_ESCROW, "0xabc");
  assert.equal(process.env.VACUNA_TEST_KEEP, "from-env");
  writeFileSync(file, "VACUNA_BUILDER_PRIVATE_KEY=0x1\n");
  assert.throws(() => loadPayerEnvFile(file), /secret/);
  delete process.env.VACUNA_TEST_ESCROW;
  delete process.env.VACUNA_TEST_KEEP;
});
