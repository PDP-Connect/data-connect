// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Lifecycle durability against the final v0.1.0 Core text: the restore
 * mechanism is declared, an AS with one store and no outside witness restores
 * through "invalidation on restore", and what it cannot detect is stated.
 * Core case D4, variants 3 (single store, snapshot predating an acknowledged
 * erasure) and 4 (a rollback through an undeclared path). PROTOTYPE.
 */
import assert from "node:assert/strict";
import { appendFileSync, copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import {
  AuthorityUnavailableError,
  HeldDataAuthority,
  type StatusResult,
} from "../lib/held-data/authority.ts";
import { journalAllowsIssuance } from "../lib/authority-journal/journal.ts";
import { getDb } from "../server/db.ts";
import { exchangeOAuthRefreshToken, introspect } from "../server/auth.ts";
import { getHeldDataRuntime, installHeldDataRuntime } from "../server/held-data/runtime.ts";
import { RESTORED_STATEMENT } from "../server/held-data/owner-statements.ts";
import {
  authCodeGrant,
  form,
  heldDataOpts,
  lifecycle,
  owner,
  registerPublicClient,
  rsRead,
  status,
} from "./helpers/held-data-as-http.ts";
import { withServer } from "./helpers/training-lease-harness.ts";

const T0 = Date.UTC(2026, 9, 12);
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const dirs: string[] = [];
const tempDir = (p: string) => {
  const d = mkdtempSync(join(tmpdir(), p));
  dirs.push(d);
  return d;
};
after(() => {
  for (const d of dirs) rmSync(d, { force: true, recursive: true });
});

function reg(as: HeldDataAuthority, grantId: string, issuedAtMs: number | null = T0 - 1000) {
  as.registerGrant({
    grantId,
    clientId: "app",
    subjectId: "owner",
    confidential: false,
    streams: ["messages"],
    expiresAtMs: null,
    issuedAtMs,
  });
}

function ask(as: HeldDataAuthority, token: string, grantIds: string[]): StatusResult[] {
  const p = as.authenticateRead({ token });
  assert.ok(p, "the token authenticates");
  return as.status(p, grantIds);
}

/** One store, no outside witness. */
function singleStore(now: () => number) {
  const dir = tempDir("pdpp-held-v010-single-");
  const journalPath = join(dir, "authority.journal");
  return { dir, journalPath, as: HeldDataAuthority.open({ journalPath, now }), reopen: () => HeldDataAuthority.open({ journalPath, now }) };
}

describe("the restore mechanism is declared (Core: Lifecycle durability)", () => {
  it("an AS with one store declares invalidation on restore, claims no disk-loss survival, and names undetected rollbacks", () => {
    const { as } = singleStore(() => T0);
    assert.equal(as.mechanism, "invalidate_on_restore");
    const d = as.durability();
    assert.equal(d.mechanism, "invalidate_on_restore");
    assert.match(d.statement, /invalidation on restore \(one store, no outside witness\)/);
    assert.match(d.does_not_survive.join(" "), /single store on a single disk and does not claim the record survives that loss/);
    assert.match(d.undetected.join(" "), /outside the declared restore procedure.*virtual-machine snapshot/);
    assert.match(
      d.statement,
      /A rollback this AS does not detect, such as a revert of a virtual-machine snapshot, can revive revoked grants and lose recorded deletions\./,
    );
  });

  it("an AS with an outside witness declares it, and says a restore of history and witness together goes undetected", () => {
    const dir = tempDir("pdpp-held-v010-witness-");
    const as = HeldDataAuthority.open({
      journalPath: join(dir, "authority.journal"),
      now: () => T0,
      epochMarkerPath: join(dir, "epoch"),
    });
    assert.equal(as.mechanism, "outside_witness");
    const d = as.durability();
    assert.match(d.statement, /loss-detection evidence kept outside the history/);
    assert.match(d.survives.join(" "), /detects the shortfall/);
    assert.match(d.does_not_survive.join(" "), /share one device here/, "journal and evidence on one device are named as one failure domain");
    assert.match(d.undetected.join(" "), /restores the history and its evidence together, such as a revert of a virtual-machine snapshot/);
    assert.match(d.statement, /can revive revoked grants and lose recorded deletions/);
  });
});

describe("D4, variant 3: one store, a snapshot predating an acknowledged erasure is restored through the declared procedure", () => {
  it("fails closed for every grant: no positive assessment, no write, no credential; owner actions are accepted; re-establishment restores service", () => {
    let now = T0;
    const { dir, journalPath, as, reopen } = singleStore(() => now);
    reg(as, "g");
    reg(as, "h");
    as.recordCredential({ token: "tg", grantIds: ["g"], kind: "access" });
    as.recordCredential({ token: "th", grantIds: ["h"], kind: "access" });
    const snapshot = join(dir, "snapshot");
    copyFileSync(journalPath, snapshot);
    now += HOUR;
    // E is acknowledged after the snapshot.
    as.end({ grantId: "g", path: "owner_withdrawal", disposition: "delete" });
    assert.equal(ask(as, "tg", ["g"])[0] && "erasures" in ask(as, "tg", ["g"])[0]!, true);

    now += HOUR;
    HeldDataAuthority.restoreFromSnapshot({ journalPath, snapshotPath: snapshot, now: () => now });
    const restored = reopen();
    assert.equal(restored.hasEnded("g"), false, "the restored history has lost E");
    assert.equal(restored.invalidated("g"), true);
    assert.equal(restored.invalidated("h"), true, "every grant whose terminal events may be missing, not only g");
    // No positive assessment, no credential, no write.
    assert.throws(() => ask(restored, "tg", ["g"]), AuthorityUnavailableError);
    assert.throws(() => ask(restored, "th", ["h"]), AuthorityUnavailableError);
    assert.throws(() => restored.requireCurrent("g"), AuthorityUnavailableError);

    // The owner's request while history is not current is accepted and recorded.
    now += HOUR;
    restored.end({ grantId: "g", path: "owner_withdrawal", disposition: "delete" });
    const view = restored.ownerView("g", 30 * DAY);
    assert.equal(view?.history_state, "restored_not_current");
    assert.equal(view?.erasures.length, 1);
    // A recorded instruction may be returned meanwhile; a positive answer for h may not.
    const a = ask(restored, "tg", ["g"])[0] as { ordinary_use: string };
    assert.equal(a.ordinary_use, "stopped");
    assert.throws(() => ask(restored, "th", ["h"]), AuthorityUnavailableError);

    // Facts recovered outside the restored history re-establish a grant.
    restored.reestablishGrants([{ grantId: "h" }]);
    assert.equal(restored.invalidated("h"), false);
    assert.equal((ask(restored, "th", ["h"])[0] as { ordinary_use: string }).ordinary_use, "permitted");
    assert.equal(restored.invalidated("g"), true, "g stays not current until its own facts are re-established");
    restored.reestablishGrants([{ grantId: "g", ended: { path: "owner_withdrawal", disposition: "delete" }, erase: true }]);
    assert.equal(restored.invalidated("g"), false);
    assert.equal((ask(restored, "tg", ["g"])[0] as { ordinary_use: string }).ordinary_use, "stopped");
    // The marker and the re-establishment are in the history: a later reopen agrees.
    assert.equal(reopen().invalidated("g"), false);
  });

  it("a grant first registered after the restore is current only if it was issued after it", () => {
    let now = T0;
    const { dir, journalPath, as, reopen } = singleStore(() => now);
    reg(as, "old");
    const snapshot = join(dir, "snapshot");
    copyFileSync(journalPath, snapshot);
    now += HOUR;
    HeldDataAuthority.restoreFromSnapshot({ journalPath, snapshotPath: snapshot, now: () => now });
    const restored = reopen();
    now += HOUR;
    reg(restored, "issued-before", T0 + 30 * 60 * 1000); // issued before the restore, unknown to the restored history
    reg(restored, "issued-after", now - 1000);
    reg(restored, "issue-time-unknown", null);
    assert.equal(restored.invalidated("issued-before"), true);
    assert.equal(restored.invalidated("issued-after"), false);
    assert.equal(restored.invalidated("issue-time-unknown"), true, "unknown issue time fails closed");
  });

  it("processing authority is not issued while any grant is not current", () => {
    let now = T0;
    const { dir, journalPath, as, reopen } = singleStore(() => now);
    reg(as, "g");
    assert.equal(journalAllowsIssuance(journalPath), true);
    const snapshot = join(dir, "snapshot");
    copyFileSync(journalPath, snapshot);
    now += HOUR;
    HeldDataAuthority.restoreFromSnapshot({ journalPath, snapshotPath: snapshot, now: () => now });
    const restored = reopen();
    assert.equal(journalAllowsIssuance(journalPath), false, "the issuance fence is shut");
    restored.reestablishGrants([{ grantId: "g" }]);
    assert.equal(journalAllowsIssuance(journalPath), true);
  });

  it("the restore replaces the history atomically and drops a torn last line", () => {
    const { dir, journalPath, as, reopen } = singleStore(() => T0);
    reg(as, "g");
    const snapshot = join(dir, "snapshot");
    copyFileSync(journalPath, snapshot);
    appendFileSync(snapshot, '{"t":"hd_end","id":"torn');
    HeldDataAuthority.restoreFromSnapshot({ journalPath, snapshotPath: snapshot, now: () => T0 + 1 });
    const restored = reopen();
    assert.equal(restored.lost, false, "a torn tail is not a corrupt history");
    assert.equal(restored.invalidated("g"), true);
  });
});

describe("D4, variant 4: a rollback through an undeclared path is not detected, and the statement says so", () => {
  it("single store: copying an older history over the store leaves no marker, so positive answers resume", () => {
    let now = T0;
    const { dir, journalPath, as, reopen } = singleStore(() => now);
    reg(as, "g");
    as.recordCredential({ token: "tg", grantIds: ["g"], kind: "access" });
    const snapshot = join(dir, "snapshot");
    copyFileSync(journalPath, snapshot);
    now += HOUR;
    as.end({ grantId: "g", path: "owner_withdrawal", disposition: "delete" });
    // A revert of a virtual-machine snapshot: the file simply goes back. No procedure runs.
    copyFileSync(snapshot, journalPath);
    const reverted = reopen();
    assert.equal(reverted.invalidated("g"), false, "nothing marks the grant");
    assert.equal(reverted.lost, false);
    const a = ask(reverted, "tg", ["g"])[0] as { ordinary_use: string };
    assert.equal(a.ordinary_use, "permitted", "the recorded deletion is lost and a revoked grant answers positive");
    // The durability statement names this path as undetected and says what it can do.
    const d = reverted.durability();
    assert.match(d.undetected.join(" "), /virtual-machine snapshot, a file copy of an older history/);
    assert.match(d.statement, /can revive revoked grants and lose recorded deletions/);
  });

  it("with an outside witness the same copy IS detected (the declared mechanism covers it)", () => {
    const dir = tempDir("pdpp-held-v010-witness-copy-");
    const journalPath = join(dir, "authority.journal");
    const now = () => T0;
    const open = () => HeldDataAuthority.open({ journalPath, now, epochMarkerPath: join(dir, "epoch") });
    const as = open();
    reg(as, "g");
    as.recordCredential({ token: "tg", grantIds: ["g"], kind: "access" });
    const snapshot = join(dir, "snapshot");
    copyFileSync(journalPath, snapshot);
    as.end({ grantId: "g", path: "owner_withdrawal", disposition: "delete" });
    copyFileSync(snapshot, journalPath);
    const reverted = open();
    assert.equal(reverted.lost, true);
    assert.throws(() => ask(reverted, "tg", ["g"]), AuthorityUnavailableError);
  });
});

describe("single-store runtime over HTTP (D4 variant 3)", () => {
  const restoreGrantRows = (grantId: string) => {
    getDb().prepare("UPDATE grants SET status = 'active', consumed = 0 WHERE grant_id = ?").run(grantId);
    getDb().prepare("UPDATE tokens SET revoked = 0 WHERE grant_id = ?").run(grantId);
    getDb().prepare("UPDATE oauth_refresh_tokens SET status = 'active', revoked_at = NULL WHERE grant_id = ?").run(grantId);
  };

  it("after a restore through the procedure, every issuance path and lifecycle answer fails closed; the owner's erase is accepted and shown pending", async () => {
    await withServer(
      false,
      async (h) => {
        const rt = getHeldDataRuntime()!;
        assert.equal(rt.authority.mechanism, "invalidate_on_restore");
        const clientId = await registerPublicClient(h);
        const g = await authCodeGrant(h, clientId);
        assert.equal((await status(h, g.refreshToken, g.grantId)).status, 200);
        const dir = tempDir("pdpp-held-v010-http-");
        const snapshot = join(dir, "snapshot");
        copyFileSync(rt.authority.journalPath, snapshot);

        // E is acknowledged, then a snapshot that predates it comes back, journal and main database both.
        const erase = await owner(h, `/v1/owner/grants/${g.grantId}/lifecycle/erase`, "POST");
        assert.equal(erase.status, 200, JSON.stringify(erase.body));
        HeldDataAuthority.restoreFromSnapshot({ journalPath: rt.authority.journalPath, snapshotPath: snapshot, now: Date.now });
        installHeldDataRuntime({ ...rt, authority: HeldDataAuthority.open({ journalPath: rt.authority.journalPath, now: Date.now }) });
        restoreGrantRows(g.grantId);

        // Lifecycle: 503 temporarily_unavailable with Retry-After; no positive assessment, no write.
        const q = await fetch(`${h.asUrl}/oauth/grant-lifecycle`, form({ grant_id: g.grantId, token: g.refreshToken }));
        assert.equal(q.status, 503);
        assert.ok(q.headers.get("retry-after"));
        assert.equal(((await q.json()) as { error: string }).error, "temporarily_unavailable");
        const write = await lifecycle(h, {
          grant_id: g.grantId,
          instruction_id: "x",
          report: "received",
          reported_at: new Date(Date.now() - 1000).toISOString(),
          token: g.refreshToken,
        });
        assert.equal(write.status, 503);
        // Credentials: no refresh exchange, no active introspection, no read.
        await assert.rejects(() => exchangeOAuthRefreshToken({ clientId, refreshToken: g.refreshToken }), /Refresh token is invalid/);
        const rows = getDb().prepare("SELECT status FROM oauth_refresh_tokens WHERE grant_id = ?").all(g.grantId) as { status: string }[];
        assert.deepEqual(rows.map((r) => r.status), ["active"], "refused before rotation: the history, not the main database, stopped it");
        assert.equal((await introspect(g.accessToken)).active, false);
        assert.notEqual(await rsRead(h, g.accessToken), 200);

        // The owner's erase is still accepted, recorded, and shown with the restore statement.
        const again = await owner(h, `/v1/owner/grants/${g.grantId}/lifecycle/erase`, "POST");
        assert.equal(again.status, 200, JSON.stringify(again.body));
        assert.equal(again.body.history_state, "restored_not_current");
        assert.equal(again.body.owner_message, RESTORED_STATEMENT);
        assert.match(String(again.body.durability), /invalidation on restore \(one store, no outside witness\)/);
        assert.match(String(again.body.durability), /virtual-machine snapshot/);
        assert.equal((again.body.erasures as unknown[]).length, 1, "the instruction is recorded");
        // The recorded instruction may be returned meanwhile.
        const meanwhile = await status(h, g.refreshToken, g.grantId);
        assert.equal(meanwhile.body.grants[0]?.held_data, "erase");
      },
      heldDataOpts(undefined, { restoreMechanism: "invalidate_on_restore" }),
    );
  });
});
