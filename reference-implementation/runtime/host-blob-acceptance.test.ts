// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Profile: pure unit, no I/O.
 *
 * Pins the BLOB -> RECORD ordering rules of `host-blob-acceptance.ts`. The TLA+
 * model in `docs/formal/host-blob-acceptance/` proves the rules safe for every
 * message order up to a bound; the walk below replays every order of the same
 * alphabet against the real module and checks the model's invariants, so the
 * code cannot drift from the model without this test failing.
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  createHostBlobAcceptance,
  type HeldHostBlob,
  type HostBlobDecision,
  type HostBlobEvent,
  hostBlobRefOf,
} from "./host-blob-acceptance.ts";

const SHA = "a".repeat(64);

function blob(key: string, stream = "attachments"): HeldHostBlob<string> {
  return { bytes: "{}", key, mimeType: "application/json", sha256: SHA, sizeBytes: 2, stream };
}

const blobEvent = (key: string): HostBlobEvent<string> => ({ blob: blob(key), kind: "blob" });
const recordEvent = (key: string, refsHostBlob: boolean, stream = "attachments"): HostBlobEvent<string> => ({
  key,
  kind: "record",
  refsHostBlob,
  stream,
});
const messageEvent = (type: string): HostBlobEvent<string> => ({ kind: "message", type });

// Behavior: a RECORD for a host-blob ref binds only the BLOB held for it.
// Defect: a record bound to the wrong blob, or a ref accepted with no blob.
test("a BLOB holds and its matching RECORD binds it; the holder is then empty", () => {
  const acceptance = createHostBlobAcceptance<string>();
  assert.deepEqual(acceptance.decide(blobEvent("k1")), { action: "hold" });
  assert.equal(acceptance.held()?.key, "k1");
  const decision = acceptance.decide(recordEvent("k1", true));
  assert.equal(decision.action, "bind");
  assert.equal(acceptance.held(), null);
});

test("a RECORD that references a host blob with none held is a violation", () => {
  const acceptance = createHostBlobAcceptance<string>();
  const decision = acceptance.decide(recordEvent("k1", true));
  assert.equal(decision.action, "violation");
});

test("a RECORD with no host blob ref passes when nothing is held", () => {
  const acceptance = createHostBlobAcceptance<string>();
  assert.deepEqual(acceptance.decide(recordEvent("k1", false)), { action: "pass" });
});

test("a RECORD for another key, another stream, or without a ref is a violation and drops the held blob", () => {
  const cases: [string, HostBlobEvent<string>][] = [
    ["other key", recordEvent("k2", true)],
    ["other stream", recordEvent("k1", true, "notes")],
    ["no ref", recordEvent("k1", false)],
  ];
  for (const [label, event] of cases) {
    const acceptance = createHostBlobAcceptance<string>();
    acceptance.decide(blobEvent("k1"));
    assert.equal(acceptance.decide(event).action, "violation", label);
    assert.equal(acceptance.held(), null, `${label}: the held blob is dropped`);
  }
});

test("array record keys match by value, not by identity", () => {
  const acceptance = createHostBlobAcceptance<string>();
  acceptance.decide({ blob: { ...blob("x"), key: ["a", "b"] }, kind: "blob" });
  assert.equal(acceptance.decide(recordEvent("x", true)).action, "violation");
  acceptance.decide({ blob: { ...blob("x"), key: ["a", "b"] }, kind: "blob" });
  const decision = acceptance.decide({ key: ["a", "b"], kind: "record", refsHostBlob: true, stream: "attachments" });
  assert.equal(decision.action, "bind");
});

test("only PROGRESS passes while a BLOB is held; every other message type is a violation", () => {
  for (const type of ["STATE", "DONE", "STREAM_EVIDENCE", "DETAIL_COVERAGE", "INTERACTION", "SKIP_RESULT", "ANYTHING"]) {
    const acceptance = createHostBlobAcceptance<string>();
    acceptance.decide(blobEvent("k1"));
    assert.equal(acceptance.decide(messageEvent(type)).action, "violation", type);
    assert.equal(acceptance.held(), null, `${type}: the held blob is dropped`);
  }
  const acceptance = createHostBlobAcceptance<string>();
  acceptance.decide(blobEvent("k1"));
  assert.deepEqual(acceptance.decide(messageEvent("PROGRESS")), { action: "pass" });
  assert.equal(acceptance.held()?.key, "k1", "PROGRESS leaves the held blob alone");
});

test("a second BLOB before the RECORD is a violation", () => {
  const acceptance = createHostBlobAcceptance<string>();
  acceptance.decide(blobEvent("k1"));
  assert.equal(acceptance.decide(blobEvent("k2")).action, "violation");
  assert.equal(acceptance.held(), null);
});

test("release drops the held blob", () => {
  const acceptance = createHostBlobAcceptance<string>();
  acceptance.decide(blobEvent("k1"));
  acceptance.release();
  assert.equal(acceptance.held(), null);
});

test("hostBlobRefOf accepts only a sha256:<hex> blob_id", () => {
  const ref = (blob_id: unknown) => ({ blob_ref: { blob_id } });
  assert.ok(hostBlobRefOf(ref(`sha256:${SHA}`)));
  for (const bad of [
    `sha256:${"A".repeat(64)}`,
    `sha256:${"a".repeat(63)}`,
    `blob_sha256_${SHA}`,
    SHA,
    "",
    7,
    null,
  ]) {
    assert.equal(hostBlobRefOf(ref(bad)), null, String(bad));
  }
  for (const bad of [null, undefined, "x", [], { blob_ref: null }, { blob_ref: [] }, { blob_ref: "x" }, {}]) {
    assert.equal(hostBlobRefOf(bad), null, JSON.stringify(bad));
  }
});

// The walk. Alphabet and bound mirror the TLA+ model: two keys, up to five
// messages. The oracle below restates the model's invariants independently of
// the module's own branching:
//   I1  a bind happens only for the key and stream of the most recent BLOB, with
//       nothing but PROGRESS between them;
//   I2  after any violation, nothing is held;
//   I3  a RECORD with a host-blob ref and no immediately preceding BLOB never
//       passes;
//   I4  while a BLOB is held, no non-PROGRESS message passes.
test("every message order up to five messages keeps the model's invariants", () => {
  const alphabet: { event: HostBlobEvent<string>; label: string }[] = [
    { event: blobEvent("k1"), label: "BLOB k1" },
    { event: blobEvent("k2"), label: "BLOB k2" },
    { event: recordEvent("k1", true), label: "RECORD k1 ref" },
    { event: recordEvent("k2", true), label: "RECORD k2 ref" },
    { event: recordEvent("k1", false), label: "RECORD k1 plain" },
    { event: messageEvent("PROGRESS"), label: "PROGRESS" },
    { event: messageEvent("STATE"), label: "STATE" },
  ];
  let sequences = 0;

  const walk = (prefix: typeof alphabet) => {
    sequences += 1;
    replay(prefix);
    if (prefix.length === 5) {
      return;
    }
    for (const step of alphabet) {
      walk([...prefix, step]);
    }
  };

  const replay = (steps: typeof alphabet) => {
    const acceptance = createHostBlobAcceptance<string>();
    let expectedHeld: string | null = null;
    for (const [index, step] of steps.entries()) {
      const where = steps
        .slice(0, index + 1)
        .map((s) => s.label)
        .join(" > ");
      const before = expectedHeld;
      const decision: HostBlobDecision<string> = acceptance.decide(step.event);
      const { event } = step;
      if (event.kind === "blob") {
        const key = (event.blob.key as string) ?? "";
        if (before === null) {
          assert.equal(decision.action, "hold", where);
          expectedHeld = key;
        } else {
          assert.equal(decision.action, "violation", where);
          expectedHeld = null;
        }
      } else if (event.kind === "record") {
        if (before === null) {
          assert.equal(decision.action, event.refsHostBlob ? "violation" : "pass", where);
        } else if (event.key === before && event.refsHostBlob) {
          assert.equal(decision.action, "bind", where);
          expectedHeld = null;
        } else {
          assert.equal(decision.action, "violation", where);
          expectedHeld = null;
        }
      } else if (before !== null && event.type !== "PROGRESS") {
        assert.equal(decision.action, "violation", where);
        expectedHeld = null;
      } else {
        assert.equal(decision.action, "pass", where);
      }
      assert.equal(acceptance.held()?.key ?? null, expectedHeld, `${where}: held blob`);
      if (decision.action === "violation") {
        assert.equal(acceptance.held(), null, `${where}: a violation leaves nothing held`);
      }
    }
  };

  walk([]);
  assert.equal(sequences, 1 + 7 + 7 ** 2 + 7 ** 3 + 7 ** 4 + 7 ** 5, "every sequence was replayed");
});
