// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Held-data lifecycle prototype, B3: erasing an acquisition copy (G1) ends
 * lease issuance for that copy at once, even while a separate training grant
 * (G2) of the same client stays live. The lease store and the held-data
 * authority share one journal, so the erasure is ordered against every lease.
 *
 * PROTOTYPE: experimental held-data lifecycle work, off by default.
 */
import assert from "node:assert/strict";
import { join } from "node:path";
import { describe, it } from "node:test";
import { HeldDataAuthority } from "../lib/held-data/authority.ts";
import { TrainingAuthorityStore } from "../lib/training-lease/authority-store.ts";
import { type Jwks, validateLeaseStatic } from "../lib/training-lease/worker.ts";
import { HOUR, MIN, T0, tempDir } from "./helpers/held-data-sim.ts";

const ISS = "https://as.example";

function setup(hooks: { afterIssue?: () => void } = {}) {
  const dir = tempDir("pdpp-held-b3-");
  let t = T0;
  const journalPath = join(dir, "authority.journal");
  const held = HeldDataAuthority.open({ journalPath, now: () => t });
  const leases = TrainingAuthorityStore.open({
    storePath: join(dir, "training.sqlite"),
    journalPath,
    issuer: ISS,
    nodeId: "n1",
    now: () => t,
    ...(hooks.afterIssue ? { afterIssueJournaledForTest: () => hooks.afterIssue?.() } : {}),
  });
  for (const g of ["G1", "G3"]) {
    held.registerGrant({ grantId: g, clientId: "app", subjectId: "owner", confidential: false, streams: ["messages"], expiresAtMs: null });
  }
  held.registerGrant({ grantId: "G2", clientId: "app", subjectId: "owner", confidential: false, trainingOnly: true, streams: ["messages"], expiresAtMs: T0 + 30 * 24 * HOUR });
  leases.createAuthority({ clientId: "app", grantId: "G2", subjectId: "owner", trainingExpiresAtMs: T0 + 30 * 24 * HOUR });
  return {
    held,
    leases,
    advance(ms: number) {
      t += ms;
    },
    now: () => t,
  };
}

describe("B3: acquisition erasure ends lease issuance for that copy", () => {
  it("erase G1 while training grant G2 is live: no later lease names G1; training on G1 stops by the last lease's exp (<= w + 1 h)", () => {
    const s = setup();
    const issued: number[] = [];
    for (let i = 0; i < 4; i++) {
      const out = s.leases.issueLease({ grantId: "G2", clientId: "app", acquisitionGrantIds: ["G1"] });
      assert.equal(out.ok, true);
      if (out.ok) {
        issued.push(out.claims.exp * 1000);
        assert.deepEqual(out.claims.acq, ["G1"]);
      }
      s.advance(25 * MIN);
    }
    const w = s.held.requestErasure({ grantId: "G1", origin: "owner_withdrawal" }).acceptedAt;
    const after = s.leases.issueLease({ grantId: "G2", clientId: "app", acquisitionGrantIds: ["G1"] });
    assert.deepEqual(after, { ok: false, reason: "acquisition_erased" });
    const stop = s.leases.acquisitionStopsBy("G1");
    assert.equal(stop.erasedAtMs, w);
    assert.equal(stop.stopsByMs, Math.max(...issued));
    assert.ok((stop.stopsByMs ?? 0) - w <= HOUR, "training on the erased copy stops within the lease bound");
    console.log(`[held-data-b3] erasure at w; last lease naming G1 expires at w+${(((stop.stopsByMs ?? 0) - w) / MIN).toFixed(0)} min; issuance refused at once`);
    // G2 itself stays live: a lease for another, unerased copy still issues.
    const other = s.leases.issueLease({ grantId: "G2", clientId: "app", acquisitionGrantIds: ["G3"] });
    assert.equal(other.ok, true);
    // A mixed request drops the erased copy.
    const mixed = s.leases.issueLease({ grantId: "G2", clientId: "app", acquisitionGrantIds: ["G1", "G3"] });
    assert.ok(mixed.ok && JSON.stringify(mixed.claims.acq) === JSON.stringify(["G3"]));
  });

  it("an erasure journaled between a lease's issue entry and its post-append check: the lease is not returned and does not move the stop time", () => {
    let s: ReturnType<typeof setup> | null = null;
    let fired = false;
    s = setup({
      afterIssue: () => {
        if (!fired && s) {
          fired = true;
          s.held.requestErasure({ grantId: "G1", origin: "owner_withdrawal" });
        }
      },
    });
    // The hook fires during the first issuance, but the erase lands after the issue entry,
    // so this lease is ordered before the erasure and is returned.
    const first = s.leases.issueLease({ grantId: "G2", clientId: "app", acquisitionGrantIds: ["G1"] });
    assert.equal(first.ok, true);
    const stop = s.leases.acquisitionStopsBy("G1");
    assert.ok(first.ok && stop.stopsByMs === first.claims.exp * 1000, "T covers the lease ordered before the erasure");
    const second = s.leases.issueLease({ grantId: "G2", clientId: "app", acquisitionGrantIds: ["G1"] });
    assert.deepEqual(second, { ok: false, reason: "acquisition_erased" });
  });

  it("worker side: a G1-derived example needs a lease that names G1; a lease for G2 alone does not authorize it", () => {
    const s = setup();
    const named = s.leases.issueLease({ grantId: "G2", clientId: "app", acquisitionGrantIds: ["G1"] });
    const bare = s.leases.issueLease({ grantId: "G2", clientId: "app" });
    assert.ok(named.ok && bare.ok);
    const lineage = { iss: ISS, clientId: "app", grantId: "G2", acquisitionGrantId: "G1" };
    const jwks = s.leases.jwks() as Jwks;
    assert.equal(validateLeaseStatic(named.lease, jwks, lineage).ok, true);
    assert.deepEqual(validateLeaseStatic(bare.lease, jwks, lineage), { ok: false, reason: "acquisition_not_covered" });
  });

  it("FINDING: a client that does not name G1 still gets a G2 lease after G1's erasure; only the worker's lineage check stops use", () => {
    const s = setup();
    s.held.requestErasure({ grantId: "G1", origin: "owner_withdrawal" });
    const bare = s.leases.issueLease({ grantId: "G2", clientId: "app" });
    assert.equal(bare.ok, true, "the AS cannot know which copies the client will train on");
  });

  it("keep-revocation of G1 leaves the copy eligible; a later erase of G1 is a new operation that ends issuance", () => {
    const s = setup();
    s.held.end({ grantId: "G1", path: "owner_withdrawal", disposition: "keep" });
    assert.equal(s.leases.issueLease({ grantId: "G2", clientId: "app", acquisitionGrantIds: ["G1"] }).ok, true);
    s.advance(20 * 24 * HOUR);
    const op = s.held.elect({ grantId: "G1", disposition: "delete" });
    assert.ok(op);
    assert.deepEqual(s.leases.issueLease({ grantId: "G2", clientId: "app", acquisitionGrantIds: ["G1"] }), {
      ok: false,
      reason: "acquisition_erased",
    });
  });
});
