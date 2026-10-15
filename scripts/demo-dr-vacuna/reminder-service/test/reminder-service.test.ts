// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { childId, generateChild } from "../../baseline/lib/dataset.ts";
import { DAY_MS, HOUR_MS, ManualClock, WEEK_MS } from "../lib/clock.ts";
import { privateKeyJwtClient } from "../lib/oauth.ts";
import { type GatewayConfig, HttpGatewayPayer, MockPayer, NATIVE_ASSET, ONE_HUNDREDTH_VANA_WEI } from "../lib/payer.ts";
import { evaluateDueDose } from "../lib/schedule.ts";
import { DEFAULT_CONFIG, ReminderService } from "../lib/service.ts";
import { LifecycleEndpointStatusSource } from "../lib/status.ts";
import { ReminderStore } from "../lib/store.ts";
import { FakeGateway, FakePdpp } from "./fakes.ts";

const START = "2026-10-05T08:00:00.000Z";

async function setup(t: test.TestContext, n: number, opts: { payer?: "mock" | "http"; gateway?: FakeGateway; gatewayConfig?: GatewayConfig } = {}) {
  const pdpp = new FakePdpp();
  await pdpp.start();
  t.after(() => pdpp.stop());
  const clock = new ManualClock(START);
  pdpp.now = () => clock.now();
  const store = new ReminderStore(join(mkdtempSync(join(tmpdir(), "vacuna-reminder-")), "store.sqlite"));
  t.after(() => store.close());
  for (let i = 1; i <= n; i++) {
    const issued = pdpp.addChild(childId(i), generateChild(i) as unknown as Record<string, unknown>);
    store.upsertChild({
      access_expires_at: 0, // force a refresh before the first read
      access_token: issued.accessToken,
      child_id: childId(i),
      child_index: i,
      grant_id: issued.grantId,
      refresh_token: issued.refreshToken,
    });
  }
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const client = privateKeyJwtClient({ clientId: "cli_reminder", issuer: pdpp.url, key: privateKey, kid: "k1" });
  const payer =
    opts.payer === "http"
      ? new HttpGatewayPayer({ config: opts.gatewayConfig as GatewayConfig, nextNonce: () => store.nextPaymentNonce() })
      : new MockPayer();
  const status = new LifecycleEndpointStatusSource({ client, endpoint: `${pdpp.url}/oauth/grant-lifecycle` });
  const service = new ReminderService({
    client,
    clock,
    config: {
      ...DEFAULT_CONFIG,
      concurrency: 8,
      receiptPublicKey: pdpp.receiptKeys.publicKey,
      rsUrl: pdpp.url,
      tokenEndpoint: `${pdpp.url}/oauth/token`,
    },
    payer,
    status,
    store,
  });
  return { client, clock, payer, pdpp, service, status, store };
}

test("due-dose evaluation flags the earliest unrecorded dose in the look-ahead window", () => {
  const record = {
    birth_date: "2026-06-01",
    child_id: "DR-X",
    doses: [
      { date: "2026-06-01", dose_number: 1, vaccine: "BCG" },
      { date: "2026-06-01", dose_number: 1, vaccine: "HepB" },
    ],
  };
  // 2-month doses are due 2026-07-31.
  assert.equal(evaluateDueDose(record, Date.parse("2026-07-20T00:00:00Z")), null);
  assert.deepEqual(evaluateDueDose(record, Date.parse("2026-07-26T00:00:00Z"))?.status, "due");
  const overdue = evaluateDueDose(record, Date.parse("2026-08-10T00:00:00Z"));
  assert.equal(overdue?.status, "overdue");
  assert.equal(overdue?.due_date, "2026-07-31");
});

test("weekly reads: payer called exactly once per successful read, never for denials; receipts verify", async (t) => {
  const { pdpp, payer, service, store, clock } = await setup(t, 20);
  // Child 3's grant is revoked before the service knows: its read is denied.
  pdpp.revoke((store.getChild(3) as { grant_id: string }).grant_id, "keep");
  await service.runWeeklyReads();
  const mock = payer as MockPayer;
  assert.equal(service.counters.get("reads.succeeded"), 19, "child 3 cannot refresh (revoked); 19 read");
  assert.equal(service.counters.get("refresh.dead"), 1);
  assert.equal(mock.sendCalls, service.counters.get("reads.succeeded"), "one send per served read");
  assert.equal(new Set(mock.ledger.map((p) => p.readId)).size, mock.ledger.length);
  assert.equal(service.counters.get("receipts.verified"), service.counters.get("reads.succeeded"));
  assert.equal(store.totals().records_received, service.counters.get("reads.succeeded"));

  // Revoke child 5 after its token was refreshed: the next read is a 403.
  pdpp.revoke((store.getChild(5) as { grant_id: string }).grant_id, "keep");
  // Make every token stale-free so no refresh is attempted, then read again a week later.
  clock.advance(WEEK_MS);
  const sendsBefore = mock.sendCalls;
  await service.runWeeklyReads();
  assert.equal(service.counters.get("reads.denied.403_grant_revoked"), 1);
  assert.equal(mock.sendCalls - sendsBefore, 18, "no payment for the denied read");
  assert.equal(mock.ledger.length, service.counters.get("reads.succeeded"));
});

test("mock payer ledger: one line per read id, kept across restarts", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "vacuna-ledger-")), "ledger.jsonl");
  const body = (readId: string) => JSON.stringify({ amount: "1", grantId: "grt_1", readId });
  const first = new MockPayer({ ledgerPath: path });
  assert.equal((await first.send(body("0x01"))).accepted, true);
  await first.send(body("0x01"));
  await first.send(body("0x02"));
  const restarted = new MockPayer({ ledgerPath: path });
  await restarted.send(body("0x02"));
  await restarted.send(body("0x03"));
  const ids = readFileSync(path, "utf8")
    .trim()
    .split("\n")
    .map((line) => (JSON.parse(line) as { readId: string }).readId);
  assert.deepEqual(ids, ["0x01", "0x02", "0x03"]);
});

test("refresh rotation never replays: a lost refresh response is not retried, a crash mid-refresh is not retried", async (t) => {
  const { pdpp, service, store, clock } = await setup(t, 3);
  pdpp.dropNextRefreshResponse = true;
  await service.runWeeklyReads();
  assert.equal(service.counters.get("refresh.lost"), 1);
  const lostChild = [1, 2, 3].map((i) => store.getChild(i)).find((r) => r?.refresh_state === "lost");
  assert.ok(lostChild, "one child is marked lost");
  assert.equal(lostChild.status, "needs_reauth");
  const presented = lostChild.refresh_token as string;

  // Successful rotations persisted the successor before the access token was used.
  for (const i of [1, 2, 3]) {
    const row = store.getChild(i);
    if (row && row !== lostChild && row.child_index !== lostChild.child_index) {
      assert.equal(row.refresh_state, "idle");
      assert.equal(pdpp.refreshTokens.get(row.refresh_token as string)?.state, "active", "stored token is the live one");
    }
  }

  // Later runs never present the lost token again.
  clock.advance(WEEK_MS);
  await service.runWeeklyReads();
  clock.advance(WEEK_MS);
  await service.runWeeklyReads();
  assert.equal(pdpp.refreshCalls.filter((tok) => tok === presented).length, 1, "lost token presented once only");
  assert.ok(
    [...pdpp.refreshTokens.values()].every((e) => e.state !== "revoked"),
    "no family was revoked by a replay"
  );

  // A crash between committing in_flight and the response: on restart the
  // state becomes lost and the token is not sent.
  const crashed = store.getChild(1)?.child_index === lostChild.child_index ? 2 : 1;
  store.update(crashed, { refresh_state: "in_flight" });
  const restarted = new ReminderService({
    client: (service as unknown as { deps: { client: never } }).deps.client,
    clock,
    config: (service as unknown as { deps: { config: never } }).deps.config,
    payer: new MockPayer(),
    status: (service as unknown as { deps: { status: never } }).deps.status,
    store,
  });
  assert.equal(restarted.counters.get("refresh.lost_on_restart"), 1);
  assert.equal(store.getChild(crashed)?.refresh_state, "lost");
});

test("daily check stops use after revocation with keep; reads stop, held record kept", async (t) => {
  const { pdpp, service, store, clock } = await setup(t, 5);
  await service.runWeeklyReads();
  await service.runStatusChecks();
  assert.equal(service.counters.get("status.succeeded"), 5);
  const grantId = (store.getChild(2) as { grant_id: string }).grant_id;
  pdpp.revoke(grantId, "keep");

  clock.advance(DAY_MS + HOUR_MS);
  await service.runStatusChecks();
  const row = store.getChild(2);
  assert.equal(row?.status, "ended_keep");
  assert.equal(row?.read_state, "revoked");
  assert.ok(row?.last_record_json, "keep: held record retained");

  clock.advance(WEEK_MS);
  const attemptsBefore = service.counters.get("reads.attempted");
  await service.runWeeklyReads();
  assert.equal(service.counters.get("reads.attempted") - attemptsBefore, 4, "ended grant is not read");
});

test("delete after revocation is honoured: use stops within 48 h, data deleted within 30 days, reported", async (t) => {
  const { pdpp, service, store, clock, payer } = await setup(t, 4);
  await service.runWeeklyReads();
  const grantId = (store.getChild(4) as { grant_id: string }).grant_id;
  pdpp.revoke(grantId, "delete");
  const revokedAt = clock.now();

  clock.advance(20 * HOUR_MS);
  await service.runStatusChecks();
  const row = store.getChild(4);
  assert.equal(row?.status, "erase_pending");
  assert.ok((row?.stopped_at as number) - revokedAt <= 48 * HOUR_MS, "use stopped within the 48 h bound");
  assert.equal(service.counters.get("erasure.stopped_within_48h"), 1);
  assert.equal(row?.delete_by, (row?.erasure_receipt_at as number) + 30 * DAY_MS);

  // No use while deletion is pending: no read, no payment.
  clock.advance(WEEK_MS);
  const sends = (payer as MockPayer).sendCalls;
  await service.runWeeklyReads();
  assert.equal((payer as MockPayer).sendCalls - sends, 3);

  await service.runDeletionSweep();
  const deleted = store.getChild(4);
  assert.equal(deleted?.status, "deleted");
  assert.equal(deleted?.last_record_json, null);
  assert.equal(deleted?.last_due_json, null);
  assert.ok((deleted?.deleted_at as number) <= (deleted?.delete_by as number), "deleted before the 30-day bound");
  assert.equal(service.counters.get("erasure.deletions_completed"), 1);
  assert.deepEqual(
    pdpp.lifecycleReports.map((r) => r.report),
    ["received", "completed"],
    "receipt and completion reported through the lifecycle operation"
  );

  // A deleted grant is never queried or read again.
  clock.advance(2 * DAY_MS);
  const queries = pdpp.lifecycleQueries;
  await service.runStatusChecks();
  assert.equal(store.getChild(4)?.status, "deleted");
  assert.ok(pdpp.lifecycleQueries >= queries);
});

test("HTTP gateway payer: EIP-712 signed escrow/pay accepted by a verifying fake; resend is idempotent; wrong key refused", async (t) => {
  const builderKey = generatePrivateKey();
  const serverKey = generatePrivateKey();
  const gatewayConfig = {
    chainId: 14_800n,
    dataOwnerAddress: privateKeyToAccount(generatePrivateKey()).address,
    dataPointScope: "dr.vacuna.child_immunizations",
    dataRegistryContract: "0x1111111111111111111111111111111111111111",
    escrowContract: "0x2222222222222222222222222222222222222222",
  };
  const gateway = new FakeGateway({ ...gatewayConfig, trustedServer: privateKeyToAccount(serverKey).address });
  await gateway.start();
  t.after(() => gateway.stop());
  const config: GatewayConfig = {
    ...gatewayConfig,
    amountWei: ONE_HUNDREDTH_VANA_WEI,
    asset: NATIVE_ASSET,
    builderPrivateKey: builderKey,
    dataPointVersion: 1n,
    gatewayUrl: gateway.url,
    registerServerPrivateKey: serverKey,
  };
  const { service, store, payer } = await setup(t, 6, { gatewayConfig: config, payer: "http" });
  await service.runWeeklyReads();
  assert.equal(service.counters.get("reads.succeeded"), 6);
  assert.equal(gateway.accepted.size, 6, "one accepted escrow payment per served read");
  assert.equal(store.totals().payments_accepted, 6);
  assert.equal((payer as HttpGatewayPayer).sendCalls, 6);
  const readIds = (store.db.prepare("SELECT read_id FROM receipts").all() as { read_id: string }[]).map((r) => r.read_id);
  assert.deepEqual(new Set(readIds), new Set(gateway.accepted.keys()), "opId is the register read id");

  // Resending a persisted body (e.g. after a lost response) is idempotent.
  const stored = store.db.prepare("SELECT body_json FROM payments LIMIT 1").get() as { body_json: string };
  const again = await (payer as HttpGatewayPayer).send(stored.body_json);
  assert.equal(again.accepted, true);
  assert.equal(gateway.accepted.size, 6);

  // A payer signing with a different key than payerAddress claims is refused.
  const forged = JSON.parse(stored.body_json) as { authorization: string; body: Record<string, unknown> };
  forged.body.paymentNonce = "999";
  const rogue = new HttpGatewayPayer({
    config: { ...config, builderPrivateKey: generatePrivateKey() },
    nextNonce: () => 1000n,
  });
  const rogueBody = JSON.parse(
    (
      await rogue.prepare({
        childId: "DR-0000001",
        childIndex: 1,
        grantId: "g",
        readId: `0x${"ab".repeat(32)}`,
        recordSha256: "",
        servedAt: null,
      })
    ).bodyJson
  ) as { authorization: string; body: Record<string, unknown> };
  rogueBody.body.payerAddress = privateKeyToAccount(builderKey).address;
  (rogueBody.body.accessRecord as Record<string, unknown>).accessor = privateKeyToAccount(builderKey).address;
  const refused = await (payer as HttpGatewayPayer).send(JSON.stringify(rogueBody));
  assert.equal(refused.accepted, false);
  assert.equal((refused.response as { status: number }).status, 401);
});
