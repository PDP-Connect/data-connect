// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { HeldDataAuthority } from "../lib/held-data/authority.ts";
import { TrainingAuthorityStore } from "../lib/training-lease/authority-store.ts";
import { DAY, HOUR, T0, tempDir } from "./helpers/held-data-sim.ts";

function setup() {
  const dir = tempDir("held-advance-recovery-");
  let now = T0;
  const opts = {
    journalPath: join(dir, "journal"),
    epochMarkerPath: join(dir, "epoch"),
    pendingPath: join(dir, "pending"),
    pendingEvidencePath: join(dir, "pending-evidence"),
    now: () => now,
  };
  const as = HeldDataAuthority.open(opts);
  const grant = {
    grantId: "acquisition", clientId: "app", subjectId: "owner",
    confidential: false, streams: ["messages"], expiresAtMs: T0 + DAY,
  };
  as.registerGrant(grant);
  const leases = TrainingAuthorityStore.open({
    journalPath: opts.journalPath, storePath: join(dir, "leases.sqlite"),
    issuer: "https://as.example", nodeId: "n1", now: opts.now,
  });
  leases.createAuthority({
    grantId: "training", clientId: "app", subjectId: "owner", trainingExpiresAtMs: T0 + DAY,
  });
  return { as, leases, opts, grant, advance: () => { now += HOUR; } };
}

describe("advance elections composed with pending recovery", () => {
  for (const disposition of ["keep", "delete"] as const) {
    it(`replaying a pending ${disposition} activates the original election before processing resumes`, () => {
      const s = setup();
      try {
        const election = s.as.electAdvance("acquisition");
        const full = readFileSync(s.opts.journalPath, "utf8");
        s.advance();
        rmSync(s.opts.journalPath);
        const lost = HeldDataAuthority.open(s.opts);
        assert.equal(lost.lost, true);
        assert.equal(lost.end({
          grantId: "acquisition", path: "owner_withdrawal", disposition, grant: s.grant,
        }).pending, true);
        writeFileSync(s.opts.journalPath, full);
        const recovering = HeldDataAuthority.open(s.opts);
        assert.deepEqual(s.leases.issueLease({
          grantId: "training", clientId: "app", acquisitionGrantIds: ["acquisition"],
        }), { ok: false, reason: "unavailable" });
        recovering.reestablishHistory();
        assert.equal(recovering.lost, false);
        // Check before serving any lifecycle answer: replay itself must revoke processing eligibility.
        assert.deepEqual(s.leases.issueLease({
          grantId: "training", clientId: "app", acquisitionGrantIds: ["acquisition"],
        }), { ok: false, reason: "acquisition_erased" });
        const erasures = recovering.ownerView("acquisition", DAY)?.erasures;
        assert.equal(erasures?.length, 1);
        assert.equal(erasures?.[0]?.operation_id, election.operationId);
        assert.equal(erasures?.[0]?.accepted_at, T0);
        assert.equal(erasures?.[0]?.effective_at, T0 + HOUR);
        recovering.reestablishHistory();
        assert.deepEqual(recovering.ownerView("acquisition", DAY)?.erasures, erasures);
      } finally {
        s.leases.close();
      }
    });
  }

  it("replaying an immediate owner election accelerates an earlier advance instruction", () => {
    const s = setup();
    try {
      const election = s.as.electAdvance("acquisition");
      const full = readFileSync(s.opts.journalPath, "utf8");
      s.advance();
      rmSync(s.opts.journalPath);
      s.as.elect({ grantId: "acquisition", disposition: "delete" });
      writeFileSync(s.opts.journalPath, full);
      const recovering = HeldDataAuthority.open(s.opts);
      recovering.reestablishHistory();
      assert.deepEqual(s.leases.issueLease({
        grantId: "training", clientId: "app", acquisitionGrantIds: ["acquisition"],
      }), { ok: false, reason: "acquisition_erased" });
      const erasure = recovering.ownerView("acquisition", DAY)?.erasures[0];
      assert.equal(erasure?.operation_id, election.operationId);
      assert.equal(erasure?.accepted_at, T0);
      assert.equal(erasure?.effective_at, T0 + HOUR);
      assert.equal(recovering.hasEnded("acquisition"), true);
    } finally {
      s.leases.close();
    }
  });

  it("retries append only one activation while preserving the instruction identifier and acceptance", () => {
    const s = setup();
    try {
      const election = s.as.electAdvance("acquisition");
      s.advance();
      s.as.end({ grantId: "acquisition", path: "owner_withdrawal", disposition: "delete" });
      s.as.end({ grantId: "acquisition", path: "owner_withdrawal", disposition: "delete" });
      const reopened = HeldDataAuthority.open(s.opts);
      reopened.end({ grantId: "acquisition", path: "owner_withdrawal", disposition: "delete" });
      const entries = readFileSync(s.opts.journalPath, "utf8").trim().split("\n")
        .map((line) => JSON.parse(line) as { t: string; id: string; accepted_at?: number });
      const activations = entries.filter((entry) => entry.t === "erase" && entry.id === election.operationId);
      assert.equal(activations.length, 1, "advance and activation share an operation ID, but are distinct journal facts");
      assert.equal(activations[0]?.accepted_at, T0);
      assert.equal(reopened.ownerView("acquisition", DAY)?.erasures.length, 1);
    } finally {
      s.leases.close();
    }
  });
});
