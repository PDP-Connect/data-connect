// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { AuthorityUnavailableError, HeldDataAuthority } from "../lib/held-data/authority.ts";
import { TrainingAuthorityStore } from "../lib/training-lease/authority-store.ts";
import { DAY, T0, tempDir } from "./helpers/held-data-sim.ts";

function setup() {
  let time = T0;
  const journalPath = join(tempDir("pdpp-d4-history-"), "history");
  const epochMarkerPath = join(tempDir("pdpp-d4-evidence-"), "epoch");
  const pendingPath = join(tempDir("pdpp-d4-pending-"), "actions");
  const pendingEvidencePath = join(tempDir("pdpp-d4-pending-evidence-"), "evidence");
  const opts = {
    journalPath,
    epochMarkerPath,
    pendingPath,
    pendingEvidencePath,
    now: () => time,
  };
  const as = HeldDataAuthority.open(opts);
  for (const grantId of ["g", "sibling"]) {
    as.registerGrant({
      grantId,
      clientId: "app",
      subjectId: "owner",
      confidential: false,
      streams: ["messages"],
      expiresAtMs: null,
    });
    as.recordCredential({
      token: grantId,
      grantIds: [grantId],
      kind: "access",
    });
  }
  const prefix = readFileSync(journalPath, "utf8");
  as.end({ grantId: "sibling", path: "owner_withdrawal", disposition: "keep" });
  const full = readFileSync(journalPath, "utf8");
  return {
    opts,
    prefix,
    full,
    grant: {
      grantId: "g",
      clientId: "app",
      subjectId: "owner",
      confidential: false,
      streams: ["messages"],
      expiresAtMs: null,
    },
    advance: () => {
      time += DAY;
    },
  };
}

function answer(as: HeldDataAuthority, grantId = "g") {
  const p = as.authenticateRead({ token: grantId });
  assert.ok(p);
  const [r] = as.status(p, [grantId]);
  assert.ok(r && !("error" in r));
  return r;
}

describe("D4 pending actions", () => {
  for (const loss of ["wiped", "suffix"] as const) {
    for (const disposition of ["delete", "keep"] as const) {
      it(`${loss}: owner ${disposition} survives restart, is idempotent, and is applied before the first answer`, () => {
        const s = setup();
        if (loss === "wiped") rmSync(s.opts.journalPath);
        else writeFileSync(s.opts.journalPath, s.prefix);
        const lost = HeldDataAuthority.open(s.opts);
        assert.equal(lost.lost, true);
        const first = lost.end({
          grantId: "g",
          path: "owner_withdrawal",
          disposition,
          grant: s.grant,
        });
        assert.equal(first.pending, true);
        s.advance();
        const reopened = HeldDataAuthority.open(s.opts);
        const retry = reopened.end({
          grantId: "g",
          path: "owner_withdrawal",
          disposition,
          grant: s.grant,
        });
        assert.deepEqual(retry, first);
        assert.equal(reopened.ownerView("g", DAY)?.pending_actions.length, 1);
        assert.throws(() => answer(reopened), AuthorityUnavailableError);
        writeFileSync(s.opts.journalPath, s.full);
        const crashed = HeldDataAuthority.open(s.opts);
        assert.equal(crashed.lost, true);
        assert.throws(() => answer(crashed), AuthorityUnavailableError);
        crashed.reestablishHistory();
        const result = answer(crashed);
        assert.equal(result.grant_state, "ended");
        assert.equal(result.ending?.ended_at, T0);
        assert.equal(result.ordinary_use, disposition === "delete" ? "stopped" : "permitted");
        assert.equal(result.erasures.length, disposition === "delete" ? 1 : 0);
        assert.deepEqual(crashed.ownerView("g", DAY)?.pending_actions, []);
        assert.equal(HeldDataAuthority.open(s.opts).lost, false);
      });
    }
  }
  it("security revocation while lost has no default disposition and requires an owner election", () => {
    const s = setup();
    writeFileSync(s.opts.journalPath, s.prefix);
    const as = HeldDataAuthority.open(s.opts);
    as.end({ grantId: "g", path: "security_revocation" });
    writeFileSync(s.opts.journalPath, s.full);
    as.reestablishHistory();
    const r = answer(as);
    assert.equal(r.ending?.path, "security_revocation");
    assert.equal(r.ending?.disposition, null);
    assert.equal(r.ending?.owner_notice_required, true);
    assert.equal(r.erasures.length, 0);
  });
  it("pending keep then delete are ordered actions; recovery retries retain the erasure id and acceptance time", () => {
    const s = setup();
    writeFileSync(s.opts.journalPath, s.prefix);
    const as = HeldDataAuthority.open(s.opts);
    as.end({ grantId: "g", path: "owner_withdrawal", disposition: "keep" });
    s.advance();
    const deleted = as.end({
      grantId: "g",
      path: "owner_withdrawal",
      disposition: "delete",
    });
    assert.equal(as.ownerView("g", DAY)?.pending_actions.length, 2);
    writeFileSync(s.opts.journalPath, s.full);
    as.reestablishHistory();
    as.reestablishHistory();
    const r = answer(as);
    assert.equal(r.ending?.disposition, "keep");
    assert.equal(r.ending?.ended_at, T0);
    assert.equal(r.erasures.length, 1);
    assert.equal(r.erasures[0]?.operation_id, deleted.erasure?.operationId);
    assert.equal(r.erasures[0]?.accepted_at, T0 + DAY);
    assert.equal(as.ownerView("g", DAY)?.erasures[0]?.delete_by, null);
    const erasure = r.erasures[0];
    assert.ok(erasure);
    as.report({
      clientId: "app",
      grantId: "g",
      operationId: erasure.operation_id,
      kind: "receipt",
      reportedAt: T0 + 2 * DAY,
    });
    assert.equal(as.ownerView("g", DAY)?.erasures[0]?.delete_by, T0 + 3 * DAY);
  });
  it("a crash during replay stays fenced, and retry applies the erasure without duplicating the ending", () => {
    const s = setup();
    writeFileSync(s.opts.journalPath, s.prefix);
    const as = HeldDataAuthority.open(s.opts);
    as.end({ grantId: "g", path: "owner_withdrawal", disposition: "delete" });
    writeFileSync(s.opts.journalPath, s.full);
    // The end append succeeds, then its durable evidence replacement fails.
    mkdirSync(`${s.opts.epochMarkerPath}.tmp`);
    assert.throws(() => as.reestablishHistory());
    assert.equal(as.lost, true);
    assert.throws(() => answer(as), AuthorityUnavailableError);
    const restarted = HeldDataAuthority.open(s.opts);
    assert.equal(restarted.lost, true);
    assert.throws(() => answer(restarted), AuthorityUnavailableError);
    rmSync(`${s.opts.epochMarkerPath}.tmp`, { recursive: true });
    restarted.reestablishHistory();
    assert.equal(answer(restarted).ordinary_use, "stopped");
    const entries = readFileSync(s.opts.journalPath, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    assert.equal(entries.filter((e) => e.grant_id === "g" && e.t === "hd_end").length, 1);
    assert.equal(entries.filter((e) => e.grant_id === "g" && e.t === "erase").length, 1);
  });

  for (const disposition of ["keep", "delete"] as const) {
    it(`shared lease store cannot issue after restoration before pending ${disposition} replay, or revive processing afterwards`, () => {
      const s = setup();
      const store = TrainingAuthorityStore.open({
        storePath: join(tempDir("pdpp-d4-lease-"), "store.sqlite"),
        journalPath: s.opts.journalPath,
        issuer: "https://as.example",
        nodeId: "n",
        now: s.opts.now,
      });
      try {
        store.createAuthority({
          clientId: "app",
          grantId: "g",
          subjectId: "owner",
          trainingExpiresAtMs: T0 + 30 * DAY,
        });
        assert.equal(store.issueLease({ clientId: "app", grantId: "g" }).ok, true);
        const full = readFileSync(s.opts.journalPath, "utf8");
        writeFileSync(s.opts.journalPath, s.prefix);
        const as = HeldDataAuthority.open(s.opts);
        as.end({ grantId: "g", path: "owner_withdrawal", disposition });
        assert.equal(store.issueLease({ clientId: "app", grantId: "g" }).ok, false);
        writeFileSync(s.opts.journalPath, full);
        const restarted = HeldDataAuthority.open(s.opts);
        assert.equal(store.issueLease({ clientId: "app", grantId: "g" }).ok, false);
        restarted.reestablishHistory();
        assert.equal(store.issueLease({ clientId: "app", grantId: "g" }).ok, false);
        assert.equal(store.status("g").state, "withdrawn");
      } finally {
        store.close();
      }
    });
  }

  for (const loss of ["wipe", "suffix", "same-length rewrite"] as const) {
    it(`pending inbox ${loss} is detected even after the main history is restored`, () => {
      const s = setup();
      writeFileSync(s.opts.journalPath, s.prefix);
      const as = HeldDataAuthority.open(s.opts);
      as.end({ grantId: "g", path: "owner_withdrawal", disposition: "delete" });
      const inbox = readFileSync(s.opts.pendingPath, "utf8");
      if (loss === "wipe") rmSync(s.opts.pendingPath);
      else if (loss === "suffix") writeFileSync(s.opts.pendingPath, inbox.slice(0, inbox.indexOf("\n") + 1));
      else writeFileSync(s.opts.pendingPath, inbox.replace('"delete"', '"retain"'));
      writeFileSync(s.opts.journalPath, s.full);
      const restarted = HeldDataAuthority.open(s.opts);
      assert.equal(restarted.lost, true);
      assert.throws(() => restarted.reestablishHistory(), AuthorityUnavailableError);
      assert.throws(() => answer(restarted), AuthorityUnavailableError);
    });
  }

  it("re-establishment rejects the truncated history rather than resetting its loss witness", () => {
    const s = setup();
    writeFileSync(s.opts.journalPath, s.prefix);
    const as = HeldDataAuthority.open(s.opts);
    as.end({ grantId: "g", path: "owner_withdrawal", disposition: "delete" });
    const evidence = readFileSync(s.opts.epochMarkerPath, "utf8");
    assert.throws(() => as.reestablishHistory(), AuthorityUnavailableError);
    assert.equal(readFileSync(s.opts.epochMarkerPath, "utf8"), evidence);
    assert.equal(as.pendingActions("g").length, 1);
  });
  it("an unwitnessed applied-marker suffix cannot suppress another acknowledged pending action", () => {
    const s = setup();
    writeFileSync(s.opts.journalPath, s.prefix);
    const as = HeldDataAuthority.open(s.opts);
    as.end({ grantId: "g", path: "owner_withdrawal", disposition: "keep" });
    as.end({ grantId: "sibling", path: "owner_withdrawal", disposition: "delete" });
    const actions = as.pendingActions();
    assert.equal(actions.length, 2);
    // Crash after append, before witness advancement; corrupt its action ID.
    appendFileSync(
      s.opts.pendingPath,
      `${JSON.stringify({ t: "pending_applied", id: "unacknowledged", grant_id: "sibling", actionId: actions[1]?.id })}\n`,
    );
    writeFileSync(s.opts.journalPath, s.full);
    const restarted = HeldDataAuthority.open(s.opts);
    assert.equal(restarted.pendingActions().length, 2);
    restarted.reestablishHistory();
    assert.equal(answer(restarted, "sibling").ordinary_use, "stopped");
  });

  it("loss of inbox and its witness cannot be mistaken for first initialization against restored history", () => {
    const s = setup();
    writeFileSync(s.opts.journalPath, s.prefix);
    const as = HeldDataAuthority.open(s.opts);
    as.end({ grantId: "g", path: "owner_withdrawal", disposition: "delete" });
    rmSync(s.opts.pendingPath);
    rmSync(s.opts.pendingEvidencePath);
    writeFileSync(s.opts.journalPath, s.full);
    const restarted = HeldDataAuthority.open(s.opts);
    assert.equal(restarted.lost, true);
    assert.throws(() => restarted.reestablishHistory(), AuthorityUnavailableError);
    assert.throws(() => answer(restarted), AuthorityUnavailableError);
  });

  it("surviving applied inbox detects loss of both the authority journal and its witness", () => {
    const s = setup();
    writeFileSync(s.opts.journalPath, s.prefix);
    const as = HeldDataAuthority.open(s.opts);
    as.end({ grantId: "g", path: "owner_withdrawal", disposition: "delete" });
    writeFileSync(s.opts.journalPath, s.full);
    as.reestablishHistory();
    assert.equal(as.pendingActions().length, 0);
    rmSync(s.opts.journalPath);
    rmSync(s.opts.epochMarkerPath);
    const restarted = HeldDataAuthority.open(s.opts);
    assert.equal(restarted.lost, true);
    assert.throws(() => restarted.reestablishHistory(), AuthorityUnavailableError);
    assert.throws(() => answer(restarted), AuthorityUnavailableError);
  });

  it("a duplicate owner action retains its receipt after replay and a second history loss", () => {
    const s = setup();
    writeFileSync(s.opts.journalPath, s.prefix);
    const as = HeldDataAuthority.open(s.opts);
    const first = as.end({ grantId: "g", path: "owner_withdrawal", disposition: "delete" });
    writeFileSync(s.opts.journalPath, s.full);
    as.reestablishHistory();
    const recovered = readFileSync(s.opts.journalPath, "utf8");
    rmSync(s.opts.journalPath);
    s.advance();
    const lostAgain = HeldDataAuthority.open(s.opts);
    const retry = lostAgain.end({ grantId: "g", path: "owner_withdrawal", disposition: "delete", grant: s.grant });
    assert.deepEqual(retry, first);
    assert.equal(lostAgain.ownerView("g", DAY)?.pending_actions.length, 1);
    writeFileSync(s.opts.journalPath, recovered);
    lostAgain.reestablishHistory();
    assert.equal(answer(lostAgain).erasures.length, 1);
  });
});
