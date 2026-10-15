// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Moksha paid-read wiring against a local fake gateway and fake chain. Keys
// are throwaway, generated in memory per test.

import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { type Hex, parseEther } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { childId, generateChild } from "../../baseline/lib/dataset.ts";
import { ManualClock } from "../../reminder-service/lib/clock.ts";
import { privateKeyJwtClient } from "../../reminder-service/lib/oauth.ts";
import { DEFAULT_CONFIG, ReminderService } from "../../reminder-service/lib/service.ts";
import { LifecycleEndpointStatusSource } from "../../reminder-service/lib/status.ts";
import { ReminderStore } from "../../reminder-service/lib/store.ts";
import { FakePdpp } from "../../reminder-service/test/fakes.ts";
import { loadConfig, type MokshaConfig } from "../lib/config.ts";
import { buildContext } from "../lib/context.ts";
import { depositNative, readBalance } from "../lib/deposit.ts";
import { initKeyFiles, keysFromSecrets, loadKeys } from "../lib/keys.ts";
import { JsonRpc } from "../lib/rpc.ts";
import { pollSettlements } from "../lib/settlement.ts";
import { SettlementWatcher } from "../lib/settlement-watch.ts";
import { MokshaState } from "../lib/state.ts";
import { FakeMoksha } from "./fake-moksha.ts";

const DATA_ACCESS = 10n ** 16n;
const GRANT_REG = 10n ** 15n;

function secrets() {
  return { builder: generatePrivateKey(), childSeed: generatePrivateKey(), register: generatePrivateKey() };
}

const readId = (n: number): Hex => `0x${n.toString(16).padStart(64, "0")}`;
const read = (child: string, n: number) => ({
  childId: child,
  childIndex: 1,
  grantId: "pdpp-grant",
  readId: readId(n),
  recordSha256: "",
  servedAt: null,
});

async function setup(t: test.TestContext, overrides: Partial<MokshaConfig> = {}, sec = secrets(), stateDir?: string) {
  const dir = stateDir ?? mkdtempSync(join(tmpdir(), "vacuna-moksha-"));
  // Ports are unknown until the fake listens, so start it with a provisional config.
  const provisional = loadConfig({ VACUNA_MOKSHA_STATE_DIR: dir }, { stateDir: dir });
  const fake = new FakeMoksha({ ...provisional, ...overrides });
  await fake.start();
  t.after(() => fake.stop());
  const config: MokshaConfig = {
    ...loadConfig({ VACUNA_GATEWAY_URL: fake.gatewayUrl, VACUNA_MOKSHA_STATE_DIR: dir, VACUNA_RPC_URL: fake.rpcUrl }, { stateDir: dir }),
    ...overrides,
  };
  const lines: Record<string, unknown>[] = [];
  const ctx = buildContext({ config, keys: keysFromSecrets(sec), log: (l) => lines.push(l) });
  return { config, ctx, dir, fake, lines, sec };
}

function assertNoSecrets(text: string, sec: Record<string, string>) {
  for (const [name, key] of Object.entries(sec)) {
    assert.ok(!text.toLowerCase().includes(key.slice(2).toLowerCase()), `${name} key leaked`);
  }
}

test("register: builder once, then server, data point and grant per child, every signature verified by the fake", async (t) => {
  const { ctx, fake, dir, sec } = await setup(t);
  const builderId = await ctx.registrar.ensureBuilder();
  const [a, b] = await Promise.all([ctx.registrar.ensureChild("DR-0000001"), ctx.registrar.ensureChild("DR-0000002")]);

  for (const path of ["/v1/builders", "/v1/servers", "/v1/data", "/v1/grants"]) {
    const posts = fake.posts(path);
    assert.ok(posts.length > 0, `${path} was called`);
    assert.ok(posts.every((c) => c.status === 201), `${path}: ${JSON.stringify(posts.map((c) => c.body))}`);
  }
  assert.equal(fake.posts("/v1/builders").length, 1, "builder registered once for two concurrent children");
  assert.equal(fake.servers.size, 2);
  assert.equal(fake.dataPoints.size, 2);
  assert.equal(fake.grants.size, 2);

  // Who signs what: the child owns the server, data point and grant; its server key signed AddData.
  const keys = ctx.keys;
  for (const c of [a, b]) {
    assert.equal(c.ownerAddress, keys.childOwner(c.childId).address);
    assert.equal(fake.servers.get(c.serverAddress.toLowerCase())?.owner, c.ownerAddress);
    const g = fake.grants.get(c.grantId as string);
    assert.equal(g?.grantor, c.ownerAddress);
    assert.equal(g?.grantee, builderId);
    assert.deepEqual(g?.scopes, [ctx.config.scope]);
    assert.equal(c.dataVersion, "1");
    assert.equal(c.grantPaid, false, "grant_registration fee is due");
  }
  assert.notEqual(a.serverAddress, b.serverAddress, "one register server key per child");
  assert.equal(keys.childOwner("DR-0000001").address, keysFromSecrets(sec).childOwner("DR-0000001").address, "deterministic");

  const stateText = readFileSync(join(dir, "moksha-state.json"), "utf8");
  assertNoSecrets(stateText, sec);

  // Rerun with the same state: nothing is posted again.
  const before = fake.calls.length;
  const again = buildContext({ config: ctx.config, keys: keysFromSecrets(sec), log: () => {} });
  await again.registrar.ensureChild("DR-0000001");
  await again.registrar.ensureChild("DR-0000002");
  assert.equal(fake.calls.length, before, "idempotent with state");

  // Lost state: the 409s are resolved by reading the rows back, same ids, no new rows.
  const lostDir = mkdtempSync(join(tmpdir(), "vacuna-moksha-lost-"));
  const lost = buildContext({ config: { ...ctx.config, stateDir: lostDir }, keys: keysFromSecrets(sec), log: () => {} });
  const a2 = await lost.registrar.ensureChild("DR-0000001");
  assert.equal(a2.serverId, a.serverId);
  assert.equal(a2.dataPointId, a.dataPointId);
  assert.equal(a2.grantId, a.grantId);
  assert.equal(lost.state.data.builder?.builderId, builderId);
  assert.ok(fake.posts("/v1/builders").some((c) => c.status === 409));
  assert.ok(fake.posts("/v1/servers").some((c) => c.status === 409));
  assert.ok(fake.posts("/v1/data").some((c) => c.status === 201), "an unsubmitted v1 may be refreshed in place");
  assert.equal(fake.grants.size, 2);
  assert.equal(fake.servers.size, 2);

  // Child cap (default 2).
  await assert.rejects(ctx.registrar.ensureChild("DR-0000003"), /child cap reached/);
});

test("the fake refuses a signature from the wrong key on every registration endpoint", async (t) => {
  const { ctx, fake } = await setup(t);
  const rogue = privateKeyToAccount(generatePrivateKey());
  const builder = ctx.keys.builder;
  // Builder: owner field names the builder, rogue signs.
  const r1 = await ctx.gateway.registerBuilder({ ...rogue, address: builder.address } as never, builder, "");
  assert.equal(r1.status, 401);
  const builderId = await ctx.registrar.ensureBuilder();
  const owner = ctx.keys.childOwner("DR-0000009");
  const server = ctx.keys.childServer("DR-0000009");
  const r2 = await ctx.gateway.registerServer({ ...rogue, address: owner.address } as never, server, ctx.config.serverUrl);
  assert.equal(r2.status, 401);
  assert.equal((await ctx.gateway.registerServer(owner, server, ctx.config.serverUrl)).status, 201);
  const r3 = await ctx.gateway.addData(rogue, {
    dataHash: readId(1),
    expectedVersion: 1n,
    metadataHash: readId(2),
    ownerAddress: owner.address,
    scope: ctx.config.scope,
  });
  assert.equal(r3.status, 401, "AddData must come from the owner or its server");
  const r4 = await ctx.gateway.registerGrant({ ...rogue, address: owner.address } as never, {
    expiresAt: 0n,
    grantVersion: 1n,
    granteeId: builderId as Hex,
    scopes: [ctx.config.scope],
  });
  assert.equal(r4.status, 401);
  assert.equal(fake.grants.size, 0);
});

test("deposit, then pay: grant form first (0.011 VANA), data_access after (0.01), idempotent resend, cap", async (t) => {
  const { ctx, fake, sec } = await setup(t, { maxPaidReads: 4 });
  const builder = ctx.keys.builder.address;
  fake.fund(builder, parseEther("5"));
  const deps = { config: ctx.config, gateway: ctx.gateway, keys: ctx.keys, log: () => {}, rpc: ctx.rpc, sleep: async () => {}, state: ctx.state };

  await assert.rejects(depositNative(deps, { amountWei: parseEther("3") }), /<= 2 VANA/);
  const d = await depositNative(deps, { amountWei: parseEther("1") });
  assert.equal(d.submittedToGateway, true);
  const tx = fake.txs.get(d.txHash.toLowerCase());
  assert.equal(tx?.from.toLowerCase(), builder.toLowerCase(), "builder signed and pays gas");
  assert.equal(tx?.value, parseEther("1"));
  assert.equal(fake.balances.get(builder.toLowerCase()), parseEther("1"));
  await assert.rejects(depositNative(deps, { amountWei: parseEther("1") }), /--again/);
  const bal = await readBalance(deps);
  assert.equal(bal.escrow.balances[0]?.balance, parseEther("1").toString());
  assert.equal(bal.paidReadsAffordable, "100");

  const payer = ctx.payer;
  // Hook: the child is not registered yet; prepare registers it first.
  const p1 = await payer.prepare(read("DR-0000001", 1));
  assert.equal(BigInt(p1.amount), GRANT_REG + DATA_ACCESS);
  assert.ok(ctx.state.data.children["DR-0000001"]?.registeredAt, "registered before the first paid read");
  const s1 = await payer.send(p1.bodyJson);
  assert.equal(s1.accepted, true, JSON.stringify(s1.response));
  const grantId = ctx.state.data.children["DR-0000001"]?.grantId as string;
  assert.equal(fake.payments.get(readId(1))?.opType, "grant");
  assert.equal(fake.payments.get(readId(1))?.opId, grantId);
  assert.equal(fake.grants.get(grantId)?.paymentStatus, "paid");

  const p2 = await payer.prepare(read("DR-0000001", 2));
  assert.equal(BigInt(p2.amount), DATA_ACCESS);
  assert.equal((await payer.send(p2.bodyJson)).accepted, true);
  assert.equal(fake.payments.get(readId(2))?.opType, "data_access");

  // Resending a stored body is a no-op on the gateway.
  assert.equal((await payer.send(p2.bodyJson)).accepted, true);
  assert.equal(fake.payments.size, 2);

  // Second child: its own grant form, signed with its own server key.
  const p3 = await payer.prepare(read("DR-0000002", 3));
  assert.equal(BigInt(p3.amount), GRANT_REG + DATA_ACCESS);
  assert.equal((await payer.send(p3.bodyJson)).accepted, true);
  const p4 = await payer.prepare(read("DR-0000002", 4));
  assert.equal((await payer.send(p4.bodyJson)).accepted, true);

  // Cap of 4 paid reads: the 5th is recorded as capped and never sent.
  const callsBefore = fake.posts("/v1/escrow/pay").length;
  const p5 = await payer.prepare(read("DR-0000001", 5));
  assert.equal(p5.amount, "0");
  const s5 = await payer.send(p5.bodyJson);
  assert.equal(s5.accepted, false);
  assert.equal(s5.retryable, false);
  assert.equal(fake.posts("/v1/escrow/pay").length, callsBefore);
  assert.equal(ctx.state.data.payments[readId(5)]?.status, "capped");
  assert.equal(fake.balances.get(builder.toLowerCase()), parseEther("1"), "nothing debited before settlement");
  assertNoSecrets(readFileSync(ctx.state.path, "utf8"), sec);
});

test("no balance: 402 stays pending (retryable) and lands after a deposit; a read during a pending grant payment waits", async (t) => {
  const { ctx, fake } = await setup(t);
  const payer = ctx.payer;
  const p1 = await payer.prepare(read("DR-0000001", 11));
  const s1 = await payer.send(p1.bodyJson);
  assert.equal(s1.accepted, false);
  assert.equal(s1.retryable, true);
  assert.equal((s1.response as { status: number }).status, 402);

  // The grant payment is still pending; the next read must wait, not fail.
  const p2 = await payer.prepare(read("DR-0000001", 12));
  assert.equal(BigInt(p2.amount), DATA_ACCESS);
  const s2 = await payer.send(p2.bodyJson);
  assert.equal(s2.retryable, true);
  assert.equal((s2.response as { status: number }).status, 403, "the gateway checks the grant before the balance");

  fake.fund(ctx.keys.builder.address, parseEther("2"));
  await depositNative(
    { config: ctx.config, gateway: ctx.gateway, keys: ctx.keys, rpc: ctx.rpc, sleep: async () => {}, state: ctx.state },
    { amountWei: parseEther("1") }
  );
  // Resend in the wrong order: the data_access read is held by the unpaid grant (403 -> retryable).
  const early = await payer.send(p2.bodyJson);
  assert.equal(early.retryable, true);
  assert.equal((early.response as { status: number }).status, 403);
  assert.equal((await payer.send(p1.bodyJson)).accepted, true);
  assert.equal((await payer.send(p2.bodyJson)).accepted, true);
});

test("reminder service with the Moksha payer: weekly reads register each child, then pay per read", async (t) => {
  const { ctx, fake } = await setup(t);
  fake.fund(ctx.keys.builder.address, parseEther("2"));
  await depositNative(
    { config: ctx.config, gateway: ctx.gateway, keys: ctx.keys, rpc: ctx.rpc, sleep: async () => {}, state: ctx.state },
    { amountWei: parseEther("1") }
  );
  const pdpp = new FakePdpp();
  await pdpp.start();
  t.after(() => pdpp.stop());
  const clock = new ManualClock("2026-10-05T08:00:00.000Z");
  pdpp.now = () => clock.now();
  const store = new ReminderStore(join(mkdtempSync(join(tmpdir(), "vacuna-reminder-")), "store.sqlite"));
  t.after(() => store.close());
  for (let i = 1; i <= 2; i++) {
    const issued = pdpp.addChild(childId(i), generateChild(i) as unknown as Record<string, unknown>);
    store.upsertChild({ access_expires_at: 0, access_token: issued.accessToken, child_id: childId(i), child_index: i, grant_id: issued.grantId, refresh_token: issued.refreshToken });
  }
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const client = privateKeyJwtClient({ clientId: "cli_reminder", issuer: pdpp.url, key: privateKey, kid: "k1" });
  const service = new ReminderService({
    client,
    clock,
    config: { ...DEFAULT_CONFIG, concurrency: 4, receiptPublicKey: pdpp.receiptKeys.publicKey, rsUrl: pdpp.url, tokenEndpoint: `${pdpp.url}/oauth/token` },
    payer: ctx.payer,
    status: new LifecycleEndpointStatusSource({ client, endpoint: `${pdpp.url}/oauth/grant-lifecycle` }),
    store,
  });
  await service.runWeeklyReads();
  clock.advance(7 * 24 * 3600 * 1000);
  await service.runWeeklyReads();
  assert.equal(service.counters.get("payments.accepted"), 4, JSON.stringify(fake.posts("/v1/escrow/pay").map((c) => c.body)));
  const kinds = [...fake.payments.values()].map((p) => p.opType).sort();
  assert.deepEqual(kinds, ["data_access", "data_access", "grant", "grant"]);
  assert.equal(fake.servers.size, 2);
  assert.equal(fake.grants.size, 2);
});

test("settlement poller maps each paid read to its recordAccessAndSettle tx and writes the dashboard", async (t) => {
  const { ctx, fake, dir } = await setup(t);
  fake.fund(ctx.keys.builder.address, parseEther("2"));
  const deps = { config: ctx.config, gateway: ctx.gateway, keys: ctx.keys, rpc: ctx.rpc, sleep: async () => {}, state: ctx.state };
  await depositNative(deps, { amountWei: parseEther("1") });
  for (const n of [21, 22, 23]) {
    const p = await ctx.payer.prepare(read("DR-0000001", n));
    assert.equal((await ctx.payer.send(p.bodyJson)).accepted, true);
  }
  const pollDeps = { ...deps, log: () => {}, registrar: ctx.registrar };
  let dash = await pollSettlements(pollDeps, { fromBlock: 0n });
  assert.deepEqual(dash.totals, { accepted: 3 });

  const hashes = fake.settle();
  dash = await pollSettlements(pollDeps, { maxRange: 2n });
  assert.deepEqual(dash.totals, { settled: 3 });
  for (const n of [21, 22, 23]) {
    const p = ctx.state.data.payments[readId(n)];
    assert.ok(p?.settleTxHash && hashes.includes(p.settleTxHash as Hex));
    assert.equal(p?.explorerUrl, `https://moksha.vanascan.io/tx/${p?.settleTxHash}`);
  }
  assert.equal(ctx.state.data.poll.unmatchedSettlements.length, 1, "the grant registration fee settles separately (opKind 4)");
  assert.equal(dash.children[0]?.grantStatus, "confirmed");
  assert.match(String(dash.children[0]?.grantTxUrl), /^https:\/\/moksha\.vanascan\.io\/tx\/0x/);
  const file = JSON.parse(readFileSync(join(dir, "settlements.json"), "utf8")) as { payments: unknown[] };
  assert.equal(file.payments.length, 3);

  // Polling again scans from the saved cursor and changes nothing.
  const again = await pollSettlements(pollDeps);
  assert.deepEqual(again.totals, { settled: 3 });
  assert.equal(ctx.state.data.poll.unmatchedSettlements.length, 1);
});

test("settlement watcher: bounded scan from a recorded start block, accepted -> settled, no overlapping polls", async (t) => {
  const { ctx, fake } = await setup(t);
  fake.fund(ctx.keys.builder.address, parseEther("2"));
  const deps = { config: ctx.config, gateway: ctx.gateway, keys: ctx.keys, log: () => {}, rpc: ctx.rpc, sleep: async () => {}, state: ctx.state };
  await depositNative(deps, { amountWei: parseEther("1") });
  const ranges: bigint[] = [];
  const call = ctx.rpc.call.bind(ctx.rpc);
  ctx.rpc.call = (async (method: string, params: unknown[] = []) => {
    if (method === "eth_getLogs") {
      ranges.push(BigInt((params[0] as { fromBlock: string }).fromBlock));
    }
    return call(method, params);
  }) as typeof ctx.rpc.call;
  const lines: Record<string, unknown>[] = [];
  const watcher = new SettlementWatcher({ deps: { ...deps, log: (l) => lines.push(l), registrar: ctx.registrar }, env: {}, intervalMs: 0 });

  // First run on a fresh state: start a small margin below the latest block, and persist it.
  const latest = fake.blockNumber;
  await watcher.poll();
  assert.equal(watcher.lastError, null);
  assert.equal(ctx.state.data.poll.startBlock, (latest - 100n).toString());
  assert.equal(JSON.parse(readFileSync(ctx.state.path, "utf8")).poll.startBlock, (latest - 100n).toString(), "saved in the state dir");

  for (const n of [31, 32]) {
    const p = await ctx.payer.prepare(read("DR-0000001", n));
    assert.equal((await ctx.payer.send(p.bodyJson)).accepted, true);
  }
  await watcher.poll();
  assert.equal(ctx.state.data.payments[readId(31)]?.status, "accepted");

  const hashes = fake.settle();
  // Three callers at once share one poll.
  const before = watcher.runs;
  await Promise.all([watcher.poll(), watcher.poll(), watcher.refreshIfStale()]);
  assert.equal(watcher.runs, before + 1, "one poll for overlapping callers");
  for (const n of [31, 32]) {
    const p = ctx.state.data.payments[readId(n)];
    assert.equal(p?.status, "settled");
    assert.ok(hashes.includes(p?.settleTxHash as Hex));
  }
  assert.equal(ctx.state.data.children["DR-0000001"]?.grantChain?.status, "confirmed");
  assert.ok(ranges.length > 0 && ranges.every((b) => b >= latest - 100n), `scan stays above the start block: ${ranges}`);
  const cursor = BigInt(ctx.state.data.poll.fromBlock as string);
  assert.equal(cursor, fake.blockNumber + 1n, "cursor past the last scanned block");

  // Fresh within staleMs: a dashboard view does not poll again.
  await watcher.refreshIfStale();
  assert.equal(watcher.runs, before + 1);
});

test("settlement watcher: unsettled reads before the first run widen the start; RPC errors are logged, never thrown", async (t) => {
  const { ctx, fake } = await setup(t);
  fake.fund(ctx.keys.builder.address, parseEther("2"));
  const deps = { config: ctx.config, gateway: ctx.gateway, keys: ctx.keys, log: () => {}, rpc: ctx.rpc, sleep: async () => {}, state: ctx.state };
  await depositNative(deps, { amountWei: parseEther("1") });
  const p = await ctx.payer.prepare(read("DR-0000001", 41));
  assert.equal((await ctx.payer.send(p.bodyJson)).accepted, true);
  fake.settle();

  const lines: Record<string, unknown>[] = [];
  const dead = new SettlementWatcher({
    deps: { ...deps, log: (l) => lines.push(l), registrar: ctx.registrar, rpc: new JsonRpc("http://127.0.0.1:1") },
    env: {},
    intervalMs: 0,
  });
  await dead.poll();
  assert.ok(dead.lastError, "error kept");
  assert.ok(lines.some((l) => l.event === "settlement_poll_failed"));
  assert.equal(ctx.state.data.poll.fromBlock, null, "no start block recorded without the chain");
  // A failed attempt counts for staleMs: a page view right after it does not retry.
  await dead.refreshIfStale();
  assert.equal(dead.runs, 1);

  const watcher = new SettlementWatcher({ deps: { ...deps, registrar: ctx.registrar }, env: {}, intervalMs: 0, lookback: 3n });
  await watcher.poll();
  assert.equal(watcher.lastError, null);
  assert.equal(ctx.state.data.poll.startBlock, (fake.blockNumber - 3n).toString(), "lookback, not the boot margin");
  assert.equal(ctx.state.data.payments[readId(41)]?.status, "settled", "a read settled before the first run is found");
  const fromEnv = new SettlementWatcher({ deps: { ...deps, registrar: ctx.registrar }, env: { VACUNA_MOKSHA_FROM_BLOCK: "7" }, intervalMs: 0 });
  ctx.state.data.poll.fromBlock = null;
  await fromEnv.poll();
  assert.equal(ctx.state.data.poll.startBlock, "7");
});

test("keys come from 0600 files named by env; nothing else is accepted and nothing is echoed", async () => {
  const dir = mkdtempSync(join(tmpdir(), "vacuna-keys-"));
  const paths = initKeyFiles(dir);
  assert.throws(() => initKeyFiles(dir), /refusing to overwrite/);
  const env = { VACUNA_BUILDER_KEY_FILE: paths.builder, VACUNA_CHILD_KEY_SEED_FILE: paths.childSeed, VACUNA_REGISTER_KEY_FILE: paths.register };
  const keys = loadKeys(env);
  assert.match(keys.builder.address, /^0x[0-9a-fA-F]{40}$/);
  assert.notEqual(keys.childOwner("DR-0000001").address, keys.childServer("DR-0000001").address);

  assert.throws(() => loadKeys({ ...env, VACUNA_REGISTER_KEY_FILE: undefined }), /VACUNA_REGISTER_KEY_FILE is not set/);
  chmodSync(paths.builder, 0o644);
  assert.throws(() => loadKeys(env), /readable by group\/others/);
  chmodSync(paths.builder, 0o600);
  const secret = readFileSync(paths.register, "utf8").trim();
  writeFileSync(paths.register, "not-a-key\n", { mode: 0o600 });
  try {
    loadKeys(env);
    assert.fail("bad key accepted");
  } catch (err) {
    assert.match((err as Error).message, /must hold one 0x-prefixed 32-byte hex/);
    assert.ok(!(err as Error).message.includes("not-a-key"), "file content is not echoed");
  }
  assert.ok(secret.length === 66);
});

test("network gate: loopback by default; Moksha gateway and RPC only via https origins on their allowlists", () => {
  const base = { VACUNA_MOKSHA_STATE_DIR: tmpdir() };
  const d = loadConfig(base, { stateDir: tmpdir() });
  assert.equal(d.gatewayUrl, "http://127.0.0.1:8787");
  assert.equal(d.rpcUrl, "http://127.0.0.1:8545");
  assert.equal(d.chainId, 14800n);
  assert.equal(d.contracts.escrow, "0x07d7769081adc3a3DBe91f5E4B98E9A5a6B292e3");

  const gw = "https://dp-rpc.moksha.vana.org";
  const rpc = "https://rpc.moksha.vana.org";
  assert.throws(() => loadConfig({ ...base, VACUNA_GATEWAY_URL: gw }, { stateDir: tmpdir() }), /VACUNA_GATEWAY_ALLOWLIST/);
  assert.throws(
    () => loadConfig({ ...base, VACUNA_GATEWAY_ALLOWLIST: gw, VACUNA_GATEWAY_URL: gw, VACUNA_RPC_URL: rpc }, { stateDir: tmpdir() }),
    /VACUNA_RPC_ALLOWLIST/
  );
  const live = loadConfig(
    { ...base, VACUNA_GATEWAY_ALLOWLIST: gw, VACUNA_GATEWAY_URL: gw, VACUNA_RPC_ALLOWLIST: rpc, VACUNA_RPC_URL: rpc },
    { stateDir: tmpdir() }
  );
  assert.equal(live.gatewayUrl, gw);
  assert.throws(
    () => loadConfig({ ...base, VACUNA_GATEWAY_ALLOWLIST: "http://dp-rpc.moksha.vana.org", VACUNA_GATEWAY_URL: "http://dp-rpc.moksha.vana.org" }, { stateDir: tmpdir() }),
    /only https/
  );
  assert.throws(
    () => loadConfig({ ...base, VACUNA_GATEWAY_ALLOWLIST: gw, VACUNA_GATEWAY_URL: "https://dp-rpc.vana.org" }, { stateDir: tmpdir() }),
    /not listed/,
    "mainnet is not Moksha"
  );
});

test("payment nonces stay unique across a wiped state dir", () => {
  let now = Date.parse("2026-10-14T00:00:00Z");
  const a = new MokshaState(mkdtempSync(join(tmpdir(), "n1-")), { now: () => new Date(now) });
  const n1 = a.nextNonce();
  const n2 = a.nextNonce();
  assert.equal(n2, n1 + 1n);
  now += 1;
  const b = new MokshaState(mkdtempSync(join(tmpdir(), "n2-")), { now: () => new Date(now) });
  assert.ok(b.nextNonce() > n2);
});
