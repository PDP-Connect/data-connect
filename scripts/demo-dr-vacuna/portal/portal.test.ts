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
  const { explorerTxBase, settlementCell, txHashOf } = await import("./reminder-web.ts");
  const hash = `0x${"ab".repeat(32)}`;
  assert.equal(txHashOf(JSON.stringify({ success: true, txHash: hash })), hash);
  assert.equal(txHashOf(JSON.stringify({ result: { transaction_hash: hash } })), hash);
  assert.equal(txHashOf(JSON.stringify({ success: true })), null);
  assert.equal(txHashOf("not json"), null);
  assert.match(explorerTxBase(), /^https:\/\/.+\/tx\/$/);
  // Mock payer: unchanged, no Moksha state.
  const mock = settlementCell({ lang: "es", payerName: "mock", responseJson: JSON.stringify({ success: true }), status: "accepted" });
  assert.equal(mock, "simulado (sin transacción)");
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

test("dashboard with the Moksha payer: payments move from accepted to settled; poll errors leave the page up", async (t) => {
  const { mkdtempSync, writeFileSync } = await import("node:fs");
  const { createServer } = await import("node:http");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { parseEther } = await import("viem");
  const { generatePrivateKey } = await import("viem/accounts");
  const { loadConfig } = await import("../moksha/lib/config.ts");
  const { depositNative } = await import("../moksha/lib/deposit.ts");
  const { FakeMoksha } = await import("../moksha/test/fake-moksha.ts");
  const { BASE, createReminderWeb } = await import("./reminder-web.ts");

  const stateDir = mkdtempSync(join(tmpdir(), "vacuna-portal-moksha-"));
  const mokshaDir = join(stateDir, "moksha");
  const fake = new FakeMoksha(loadConfig({}, { stateDir: mokshaDir }));
  await fake.start();
  t.after(() => fake.stop());
  const env = {
    VACUNA_BUILDER_PRIVATE_KEY: generatePrivateKey(),
    VACUNA_CHILD_KEY_SEED: generatePrivateKey(),
    VACUNA_EXPLORER_TX_URL: "https://explorer.test/tx/",
    VACUNA_GATEWAY_URL: fake.gatewayUrl,
    VACUNA_MOKSHA_STATE_DIR: mokshaDir,
    VACUNA_PAYER: "moksha",
    VACUNA_REGISTER_SERVER_PRIVATE_KEY: generatePrivateKey(),
    VACUNA_RPC_URL: fake.rpcUrl,
  };
  const saved = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]));
  Object.assign(process.env, env);
  t.after(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  // A registered client skips /oauth/register; the AS itself is unreachable (status checks fail quietly).
  const publicOrigin = "http://portal.test";
  writeFileSync(join(stateDir, "client.json"), JSON.stringify({ clientId: "cli_test", redirectUri: `${publicOrigin}${BASE}/callback` }));
  const web = await createReminderWeb({
    asInternal: "http://127.0.0.1:1",
    issuer: publicOrigin,
    publicOrigin,
    rsInternal: "http://127.0.0.1:1",
    settlementPollMs: 0,
    settlementStaleMs: 0,
    stateDir,
  });
  t.after(() => web.close());
  const moksha = web.moksha;
  assert.ok(moksha && web.settlements);
  const server = createServer((req, res) => void web.handle(req, res));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const { port } = server.address() as { port: number };
  const panel = async (lang: string) => {
    const resp = await fetch(`http://127.0.0.1:${port}${BASE}/panel?lang=${lang}`);
    return { html: await resp.text(), status: resp.status };
  };

  fake.fund(moksha.keys.builder.address, parseEther("2"));
  await depositNative(
    { config: moksha.config, gateway: moksha.gateway, keys: moksha.keys, log: () => {}, rpc: moksha.rpc, sleep: async () => {}, state: moksha.state },
    { amountWei: parseEther("1") }
  );
  const readIds = [1, 2].map((n) => `0x${n.toString(16).padStart(64, "0")}`);
  for (const [i, readId] of readIds.entries()) {
    const p = await moksha.payer.prepare({ childId: "DR-9100001", childIndex: 9100001, grantId: "g", readId, recordSha256: "", servedAt: null });
    const sent: { accepted: boolean; response: unknown } = await moksha.payer.send(p.bodyJson);
    assert.equal(sent.accepted, true);
    web.store.db
      .prepare("INSERT INTO payments (read_id, child_index, amount, body_json, status, response_json, created_at) VALUES (?, ?, ?, ?, 'accepted', ?, ?)")
      .run(readId, 9100001, p.amount, p.bodyJson, JSON.stringify(sent.response), Date.now() + i);
  }

  let page = await panel("es");
  assert.equal(page.status, 200);
  assert.equal((page.html.match(/aceptado, sin transacción todavía/g) ?? []).length, 2, "accepted before the relayer settles");
  assert.doesNotMatch(page.html, /data-settled/);

  fake.settle();
  page = await panel("es");
  for (const readId of readIds) {
    const hash: string | null | undefined = moksha.state.data.payments[readId]?.settleTxHash;
    assert.ok(hash, `settle tx for ${readId}`);
    assert.ok(page.html.includes(`href="https://explorer.test/tx/${hash}"`), "links the explorer from VACUNA_EXPLORER_TX_URL");
  }
  assert.equal((page.html.match(/<span data-settled>liquidado<\/span>/g) ?? []).length, 2);
  assert.equal((page.html.match(/data-settlement="settled"/g) ?? []).length, 2);
  assert.match(page.html, /cuota de la autorización liquidada: <a href="https:\/\/explorer\.test\/tx\/0x[0-9a-f]{64}"/, "grant fee settle tx");
  const en = await panel("en");
  assert.equal((en.html.match(/<span data-settled>settled<\/span>/g) ?? []).length, 2);
  assert.match(en.html, /grant fee settled: <a /);

  // showPayments: false (the shared demo): same paid, settled reads, no payment or chain wording on the page.
  const hidden = await createReminderWeb({
    asInternal: "http://127.0.0.1:1",
    issuer: publicOrigin,
    publicOrigin,
    rsInternal: "http://127.0.0.1:1",
    settlementPollMs: 0,
    settlementStaleMs: 0,
    showPayments: false,
    stateDir,
  });
  t.after(() => hidden.close());
  const hiddenServer = createServer((req, res) => void hidden.handle(req, res));
  await new Promise<void>((resolve) => hiddenServer.listen(0, "127.0.0.1", resolve));
  t.after(() => hiddenServer.close());
  for (const lang of ["es", "en"]) {
    const resp = await fetch(`http://127.0.0.1:${(hiddenServer.address() as { port: number }).port}${BASE}/panel?lang=${lang}`);
    const html = await resp.text();
    assert.equal(resp.status, 200);
    assert.match(html, /data-stat="reads"/, "the rest of the dashboard stays");
    assert.doesNotMatch(html, /data-payment|data-stat="payments"|data-settle|explorer\.test|0x[0-9a-f]{10}/);
    assert.doesNotMatch(html, /VANA|Moksha|pago|payment|liquid|settle|cadena|chain|transacci|transaction/i);
  }

  // The chain goes away: the poll fails, the page still renders what is known.
  await fake.stop();
  page = await panel("es");
  assert.equal(page.status, 200);
  assert.ok(web.settlements?.lastError, "poll error recorded");
  assert.equal((page.html.match(/<span data-settled>liquidado<\/span>/g) ?? []).length, 2);
});

test("reset wipes walkthrough state but keeps the volume's lost+found, Moksha state and *.env", async () => {
  const { mkdtempSync, mkdirSync, writeFileSync, readdirSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { wipeStateDir } = await import("./reset-state.ts");
  const dir = mkdtempSync(join(tmpdir(), "vacuna-reset-"));
  for (const d of ["lost+found", "moksha", "reminder"]) {
    mkdirSync(join(dir, d));
  }
  writeFileSync(join(dir, "moksha", "state.json"), "{}");
  writeFileSync(join(dir, "payer.env"), "X=1");
  writeFileSync(join(dir, "reset-requested"), "");
  writeFileSync(join(dir, "reminder.sqlite"), "");
  wipeStateDir(dir);
  assert.deepEqual(readdirSync(dir).sort(), ["lost+found", "moksha", "payer.env"]);
  assert.deepEqual(readdirSync(join(dir, "moksha")), ["state.json"]);
});
