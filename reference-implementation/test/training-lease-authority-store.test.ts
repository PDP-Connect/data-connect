// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * AI-training lease prototype: AS authority record (lease note L1, L2, L3, L4, L9).
 *
 * The invariant under test is L3's: once a withdrawal commits, every lease
 * the AS ever returned for that grant has `exp` <= the stop time T shown to
 * the owner, and no lease is returned afterwards. It is checked under a real
 * multi-connection race, store restore, a crash mid-withdrawal, and stale
 * nodes.
 *
 * PROTOTYPE: experimental AI Training Profile work, off by default.
 */
import assert from "node:assert/strict";
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  renameSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { Worker } from "node:worker_threads";
import Database from "./helpers/sqlite-driver.ts";
import {
  type AuthorityStoreOptions,
  TrainingAuthorityStore,
} from "../lib/training-lease/authority-store.ts";
import { AI_TRAINING_PERMISSION } from "../lib/training-lease/constants.ts";
import {
  type InputLineage,
  type Jwks,
  validateLeaseStatic,
} from "../lib/training-lease/worker.ts";

const HOUR = 60 * 60 * 1000;
const MIN = 60 * 1000;
const T0 = Date.UTC(2026, 9, 8, 12, 0, 0);
const dirs: string[] = [];

after(() => {
  for (const d of dirs) {
    rmSync(d, { recursive: true, force: true });
  }
});

function tempPaths() {
  const dir = mkdtempSync(join(tmpdir(), "pdpp-lease-store-"));
  dirs.push(dir);
  // The journal sits in a separate directory: it must survive a restore of
  // the store directory.
  const journalDir = mkdtempSync(join(tmpdir(), "pdpp-lease-journal-"));
  dirs.push(journalDir);
  return {
    dir,
    storePath: join(dir, "authority.sqlite"),
    journalPath: join(journalDir, "authority.journal"),
  };
}

function openNode(
  paths: { storePath: string; journalPath: string },
  clock: { now: number },
  extra: Partial<AuthorityStoreOptions> = {},
): TrainingAuthorityStore {
  return TrainingAuthorityStore.open({
    storePath: paths.storePath,
    journalPath: paths.journalPath,
    issuer: "https://as.example",
    nodeId: extra.nodeId ?? "node-a",
    now: () => clock.now,
    ...extra,
  });
}

function seed(
  store: TrainingAuthorityStore,
  grantId = "grt_1",
  expiresInMs = 30 * 24 * HOUR,
  nowMs = T0,
) {
  store.createAuthority({
    grantId,
    clientId: "client_1",
    subjectId: "owner_1",
    trainingExpiresAtMs: nowMs + expiresInMs,
  });
}

/** Back up a WAL-mode store the way an operator would: a consistent snapshot. */
function backup(storePath: string, to: string): void {
  const db = new Database(storePath);
  db.exec(`VACUUM INTO '${to.replaceAll("'", "''")}'`);
  db.close();
}

/** Replace the store directory's files with a backup, leaving open handles on the old inodes. */
function restoreUnderRunningNodes(storePath: string, backupPath: string): void {
  for (const suffix of ["", "-wal", "-shm"]) {
    if (existsSync(storePath + suffix)) {
      renameSync(
        storePath + suffix,
        `${storePath}${suffix}.replaced-${Date.now()}`,
      );
    }
  }
  copyFileSync(backupPath, storePath);
}

describe("L1/L2 lease shape", () => {
  it("signs an EdDSA JWS with the L1 claims and a lifetime of at most one hour", () => {
    const clock = { now: T0 };
    const store = openNode(tempPaths(), clock);
    seed(store);
    const out = store.issueLease({ grantId: "grt_1", clientId: "client_1" });
    assert.equal(out.ok, true);
    if (!out.ok) return;
    assert.deepEqual(Object.keys(out.claims).sort(), [
      "aud",
      "exp",
      "grant_id",
      "iat",
      "iss",
      "jti",
      "permission",
    ]);
    assert.equal(out.claims.permission, AI_TRAINING_PERMISSION);
    assert.equal(out.claims.aud, "client_1");
    assert.equal(out.claims.exp - out.claims.iat, 3600);
    const lineage: InputLineage = {
      iss: "https://as.example",
      clientId: "client_1",
      grantId: "grt_1",
    };
    const v = validateLeaseStatic(out.lease, store.jwks() as Jwks, lineage);
    assert.equal(v.ok, true);
    store.close();
  });

  it("never issues past the grant's training expires_at, and issues nothing after it", () => {
    const clock = { now: T0 };
    const store = openNode(tempPaths(), clock);
    seed(store, "grt_1", 20 * MIN);
    const out = store.issueLease({ grantId: "grt_1", clientId: "client_1" });
    assert.equal(out.ok, true);
    if (out.ok) {
      assert.equal(out.claims.exp * 1000, T0 + 20 * MIN);
    }
    clock.now = T0 + 20 * MIN;
    assert.deepEqual(
      store.issueLease({ grantId: "grt_1", clientId: "client_1" }),
      {
        ok: false,
        reason: "expired",
      },
    );
    assert.equal(store.status("grt_1").state, "expired");
    store.close();
  });

  it("refuses another client's grant and an unknown grant (the HTTP layer makes these uniform)", () => {
    const store = openNode(tempPaths(), { now: T0 });
    seed(store);
    assert.deepEqual(
      store.issueLease({ grantId: "grt_1", clientId: "client_2" }),
      {
        ok: false,
        reason: "wrong_client",
      },
    );
    assert.deepEqual(
      store.issueLease({ grantId: "grt_x", clientId: "client_1" }),
      {
        ok: false,
        reason: "unknown_grant",
      },
    );
    store.close();
  });
});

describe("L3 stop time", () => {
  it("T is the stored maximum exp of leases actually issued", () => {
    const clock = { now: T0 };
    const store = openNode(tempPaths(), clock);
    seed(store);
    store.issueLease({ grantId: "grt_1", clientId: "client_1" });
    clock.now = T0 + 25 * MIN;
    const second = store.issueLease({ grantId: "grt_1", clientId: "client_1" });
    assert.ok(second.ok);
    clock.now = T0 + 26 * MIN;
    const w = store.withdraw({
      grantId: "grt_1",
      reason: "training_withdrawn",
    });
    assert.deepEqual(w, {
      state: "withdrawn",
      stopsByMs: T0 + 25 * MIN + HOUR,
      alreadyWithdrawn: false,
    });
    assert.deepEqual(
      store.issueLease({ grantId: "grt_1", clientId: "client_1" }),
      {
        ok: false,
        reason: "withdrawn",
      },
    );
    store.close();
  });

  it("T is the withdrawal time when no lease was ever issued", () => {
    const clock = { now: T0 };
    const store = openNode(tempPaths(), clock);
    seed(store);
    clock.now = T0 + 5 * MIN;
    const w = store.withdraw({
      grantId: "grt_1",
      reason: "training_withdrawn",
    });
    assert.equal(w.state === "withdrawn" && w.stopsByMs, T0 + 5 * MIN);
    store.close();
  });

  it("a second withdrawal is idempotent and keeps T", () => {
    const clock = { now: T0 };
    const store = openNode(tempPaths(), clock);
    seed(store);
    store.issueLease({ grantId: "grt_1", clientId: "client_1" });
    const first = store.withdraw({
      grantId: "grt_1",
      reason: "training_withdrawn",
    });
    clock.now = T0 + 2 * HOUR;
    const second = store.withdraw({
      grantId: "grt_1",
      reason: "grant_revoked",
    });
    assert.equal(first.state, "withdrawn");
    assert.equal(second.state, "withdrawn");
    if (first.state === "withdrawn" && second.state === "withdrawn") {
      assert.equal(second.stopsByMs, first.stopsByMs);
      assert.equal(second.alreadyWithdrawn, true);
    }
    store.close();
  });
});

describe("L3 conformance: issuance racing withdrawal (concurrent connections)", () => {
  for (let round = 0; round < 5; round += 1) {
    it(`round ${round}: every returned lease has exp <= T, and none is returned after withdrawal`, async () => {
      const paths = tempPaths();
      const clock = { now: T0 };
      const main = openNode(paths, clock, { nodeId: "withdrawer" });
      seed(main);
      const counter = new Int32Array(new SharedArrayBuffer(4));
      const workers = [0, 1, 2].map(
        (i) =>
          new Promise<{
            issued: Array<{ jti: string; exp: number }>;
            refusal: string | null;
          }>((resolve, reject) => {
            const w = new Worker(
              new URL(
                "./helpers/training-lease-issuer-worker.ts",
                import.meta.url,
              ),
              {
                workerData: {
                  ...paths,
                  grantId: "grt_1",
                  clientId: "client_1",
                  nodeId: `issuer-${i}`,
                  baseMs: T0,
                  maxAttempts: 100_000,
                  counter,
                },
              },
            );
            w.once("message", resolve);
            w.once("error", reject);
          }),
      );
      // Start barrier: withdraw only once the issuers are mid-stream.
      const target = 20 + round * 40;
      while (Atomics.load(counter, 0) < target) {
        await new Promise((r) => setImmediate(r));
      }
      const withdrawal = main.withdraw({
        grantId: "grt_1",
        reason: "training_withdrawn",
      });
      const results = await Promise.all(workers);
      assert.equal(withdrawal.state, "withdrawn");
      if (withdrawal.state !== "withdrawn") return;
      const all = results.flatMap((r) => r.issued);
      assert.ok(
        all.length > 0,
        "the race should let some leases through before the withdrawal",
      );
      for (const r of results) {
        assert.equal(
          r.refusal,
          "withdrawn",
          "every issuer stopped because of the withdrawal",
        );
      }
      const maxExpMs = Math.max(...all.map((l) => l.exp * 1000));
      assert.ok(
        maxExpMs <= withdrawal.stopsByMs,
        `lease exp ${maxExpMs} exceeds shown T ${withdrawal.stopsByMs}`,
      );
      // T is tight: it equals the latest lease actually returned. Issue entries
      // journaled after the tombstone were refused and do not count.
      assert.equal(withdrawal.stopsByMs, maxExpMs);
      const returned = new Set(all.map((l) => l.jti));
      const refusedAfterTombstone = main
        .issuances("grt_1")
        .filter((l) => !returned.has(l.jti));
      process.stdout.write(
        `# race round ${round}: returned=${all.length} journaled_but_refused=${refusedAfterTombstone.length}\n`,
      );
      main.close();
    });
  }
});

describe("L3 conformance: restore from a backup taken before the withdrawal", () => {
  it("the journal tombstone survives a restore of the authority store; T is preserved", () => {
    const paths = tempPaths();
    const clock = { now: T0 };
    let store = openNode(paths, clock);
    seed(store);
    store.issueLease({ grantId: "grt_1", clientId: "client_1" });
    const bak = join(paths.dir, "backup.sqlite");
    backup(paths.storePath, bak);
    clock.now = T0 + 10 * MIN;
    const w = store.withdraw({
      grantId: "grt_1",
      reason: "training_withdrawn",
    });
    store.close();
    restoreUnderRunningNodes(paths.storePath, bak);
    clock.now = T0 + 11 * MIN;
    store = openNode(paths, clock, { nodeId: "node-b" });
    const s = store.status("grt_1");
    assert.equal(s.state, "withdrawn");
    assert.equal(
      s.state === "withdrawn" && w.state === "withdrawn" && s.stopsByMs,
      w.state === "withdrawn" && w.stopsByMs,
    );
    assert.deepEqual(
      store.issueLease({ grantId: "grt_1", clientId: "client_1" }),
      {
        ok: false,
        reason: "withdrawn",
      },
    );
    store.close();
  });

  it("leases issued after the backup are covered: the journal replays them into the restored store", () => {
    const paths = tempPaths();
    const clock = { now: T0 };
    let store = openNode(paths, clock);
    seed(store);
    const bak = join(paths.dir, "backup.sqlite");
    backup(paths.storePath, bak);
    clock.now = T0 + 40 * MIN;
    const lost = store.issueLease({ grantId: "grt_1", clientId: "client_1" });
    assert.ok(lost.ok);
    store.close();
    restoreUnderRunningNodes(paths.storePath, bak);
    clock.now = T0 + 41 * MIN;
    store = openNode(paths, clock, { nodeId: "node-b" });
    const w = store.withdraw({
      grantId: "grt_1",
      reason: "training_withdrawn",
    });
    assert.ok(w.state === "withdrawn" && lost.ok);
    if (w.state === "withdrawn" && lost.ok) {
      assert.equal(
        w.stopsByMs,
        lost.claims.exp * 1000,
        "T covers, exactly, a lease the restored store forgot",
      );
    }
    store.close();
  });

  it("a crash after the tombstone is journaled but before the store commits still withdraws", () => {
    const paths = tempPaths();
    const clock = { now: T0 };
    let store = openNode(paths, clock, {
      afterTombstoneJournaledForTest: () => {
        throw new Error("simulated crash");
      },
    });
    seed(store);
    store.issueLease({ grantId: "grt_1", clientId: "client_1" });
    assert.throws(
      () => store.withdraw({ grantId: "grt_1", reason: "training_withdrawn" }),
      /simulated crash/,
    );
    // The store transaction rolled back: this node still sees the grant active.
    assert.equal(store.get("grt_1")?.state, "active");
    store.close();
    store = openNode(paths, clock, { nodeId: "node-a-restarted" });
    assert.equal(store.status("grt_1").state, "withdrawn");
    assert.deepEqual(
      store.issueLease({ grantId: "grt_1", clientId: "client_1" }),
      {
        ok: false,
        reason: "withdrawn",
      },
    );
    store.close();
  });
});

describe("L3 conformance: a stale node", () => {
  it("a node writing to a replaced store file: its earlier leases are in T, later ones are refused", () => {
    const paths = tempPaths();
    const clock = { now: T0 };
    const nodeA = openNode(paths, clock, { nodeId: "node-a" });
    seed(nodeA);
    const bak = join(paths.dir, "backup.sqlite");
    backup(paths.storePath, bak);
    restoreUnderRunningNodes(paths.storePath, bak);
    // Node A keeps its handle on the replaced file.
    clock.now = T0 + MIN;
    const ghost = nodeA.issueLease({ grantId: "grt_1", clientId: "client_1" });
    assert.ok(ghost.ok);
    const nodeB = openNode(paths, clock, { nodeId: "node-b" });
    clock.now = T0 + 2 * MIN;
    const w = nodeB.withdraw({
      grantId: "grt_1",
      reason: "training_withdrawn",
    });
    assert.ok(w.state === "withdrawn" && ghost.ok);
    if (w.state === "withdrawn" && ghost.ok) {
      assert.equal(w.stopsByMs, ghost.claims.exp * 1000);
    }
    clock.now = T0 + 3 * MIN;
    assert.deepEqual(
      nodeA.issueLease({ grantId: "grt_1", clientId: "client_1" }),
      {
        ok: false,
        reason: "withdrawn",
      },
    );
    nodeA.close();
    nodeB.close();
  });

  it("holds when the stale node's clock runs ahead: T comes from the journal, not from node clocks", () => {
    const paths = tempPaths();
    const clockB = { now: T0 + MIN };
    const clockA = { now: T0 + MIN + 10 * MIN };
    const nodeA = openNode(paths, clockA, { nodeId: "node-a" });
    seed(nodeA, "grt_1", 30 * 24 * HOUR, T0);
    const bak = join(paths.dir, "backup.sqlite");
    backup(paths.storePath, bak);
    restoreUnderRunningNodes(paths.storePath, bak);
    const ghost = nodeA.issueLease({ grantId: "grt_1", clientId: "client_1" });
    const nodeB = openNode(paths, clockB, { nodeId: "node-b" });
    const w = nodeB.withdraw({
      grantId: "grt_1",
      reason: "training_withdrawn",
    });
    assert.ok(w.state === "withdrawn" && ghost.ok);
    if (w.state === "withdrawn" && ghost.ok) {
      assert.ok(ghost.claims.exp * 1000 <= w.stopsByMs);
    }
    nodeA.close();
    nodeB.close();
  });

  it("a withdrawal that lands between a node's journal append and its check: the lease is returned and is inside T", () => {
    const paths = tempPaths();
    const clock = { now: T0 };
    const box: {
      nodeB: TrainingAuthorityStore | null;
      w: ReturnType<TrainingAuthorityStore["withdraw"]> | null;
    } = { nodeB: null, w: null };
    // Node A uses a separate store file (a stale copy) so that node B's
    // withdrawal is not blocked by A's SQLite lock: only the journal orders them.
    const staleCopy = join(paths.dir, "stale-copy.sqlite");
    const nodeA0 = openNode(paths, clock, { nodeId: "seed" });
    seed(nodeA0);
    nodeA0.close();
    backup(paths.storePath, staleCopy);
    const nodeA = openNode(
      { storePath: staleCopy, journalPath: paths.journalPath },
      clock,
      {
        nodeId: "node-a",
        afterIssueJournaledForTest: () => {
          if (box.nodeB && !box.w) {
            box.w = box.nodeB.withdraw({
              grantId: "grt_1",
              reason: "training_withdrawn",
            });
          }
        },
      },
    );
    box.nodeB = openNode(paths, clock, { nodeId: "node-b" });
    const lease = nodeA.issueLease({ grantId: "grt_1", clientId: "client_1" });
    const wd = box.w as ReturnType<TrainingAuthorityStore["withdraw"]> | null;
    assert.ok(lease.ok && wd?.state === "withdrawn");
    if (lease.ok && wd?.state === "withdrawn") {
      assert.equal(wd.stopsByMs, lease.claims.exp * 1000);
    }
    nodeA.close();
    box.nodeB.close();
  });

  it("a tombstone that a stale node's store copy never saw makes the stale node refuse", () => {
    const paths = tempPaths();
    const clock = { now: T0 };
    const nodeA = openNode(paths, clock, { nodeId: "node-a" });
    seed(nodeA);
    const bak = join(paths.dir, "backup.sqlite");
    backup(paths.storePath, bak);
    restoreUnderRunningNodes(paths.storePath, bak);
    const nodeB = openNode(paths, clock, { nodeId: "node-b" });
    const w = nodeB.withdraw({
      grantId: "grt_1",
      reason: "training_withdrawn",
    });
    assert.ok(w.state === "withdrawn");
    assert.deepEqual(
      nodeA.issueLease({ grantId: "grt_1", clientId: "client_1" }),
      {
        ok: false,
        reason: "withdrawn",
      },
    );
    nodeA.close();
    nodeB.close();
  });

  it("a node that cannot get the record in time does not issue", () => {
    const paths = tempPaths();
    const store = openNode(paths, { now: T0 }, { busyTimeoutMs: 50 });
    seed(store);
    const blocker = new Database(paths.storePath);
    blocker.exec("BEGIN IMMEDIATE");
    assert.deepEqual(
      store.issueLease({ grantId: "grt_1", clientId: "client_1" }),
      {
        ok: false,
        reason: "unavailable",
      },
    );
    blocker.exec("ROLLBACK");
    blocker.close();
    assert.ok(store.issueLease({ grantId: "grt_1", clientId: "client_1" }).ok);
    store.close();
  });
});

describe("L9 signing keys", () => {
  it("keeps a retired key in the JWKS until the last lease it signed expires", () => {
    const clock = { now: T0 };
    const store = openNode(tempPaths(), clock);
    seed(store);
    const first = store.issueLease({ grantId: "grt_1", clientId: "client_1" });
    assert.ok(first.ok);
    const oldKid = first.ok ? first.kid : "";
    clock.now = T0 + 10 * MIN;
    const newKid = store.rotateSigningKey();
    const second = store.issueLease({ grantId: "grt_1", clientId: "client_1" });
    assert.equal(second.ok && second.kid, newKid);
    const kids = () => store.jwks().keys.map((k) => k.kid);
    assert.deepEqual(kids().sort(), [newKid, oldKid].sort());
    clock.now = T0 + HOUR - 1000;
    assert.ok(kids().includes(oldKid));
    clock.now = T0 + HOUR;
    assert.deepEqual(kids(), [newKid]);
    store.close();
  });

  it("an emergency revocation removes the key from the JWKS at once", () => {
    const clock = { now: T0 };
    const store = openNode(tempPaths(), clock);
    seed(store);
    const lease = store.issueLease({ grantId: "grt_1", clientId: "client_1" });
    assert.ok(lease.ok);
    if (!lease.ok) return;
    store.revokeSigningKey(lease.kid);
    assert.ok(!store.jwks().keys.some((k) => k.kid === lease.kid));
    const lineage: InputLineage = {
      iss: "https://as.example",
      clientId: "client_1",
      grantId: "grt_1",
    };
    assert.deepEqual(
      validateLeaseStatic(lease.lease, store.jwks() as Jwks, lineage),
      {
        ok: false,
        reason: "unknown_key",
      },
    );
    assert.ok(
      store.issueLease({ grantId: "grt_1", clientId: "client_1" }).ok,
      "a new key is created",
    );
    store.close();
  });
});
