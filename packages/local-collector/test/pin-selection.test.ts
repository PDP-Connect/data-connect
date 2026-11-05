// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * `pin-collection-profiles.ts` decides which release each connector pins. A
 * re-run must not move a pin nobody asked it to move, and a mistyped argument
 * must fail instead of passing for a no-op.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { COLLECTION_PROFILE_PINS } from "../src/generated/collection-profile-pins.generated.ts";
import { choosePin, parseHolds, parsePinArguments } from "../scripts/pin-selection.ts";

const KEYS = new Set(["claude-code", "codex", "imessage"]);
const hold = { version: "0.3.4", reason: "latest drops a stream" };

test("with no flag a connector keeps its current pin, even one below the latest release", () => {
  const args = parsePinArguments([], KEYS);
  assert.deepEqual(choosePin({ connectorKey: "codex", args, hold: undefined, currentVersion: "0.3.3" }), {
    kind: "version",
    version: "0.3.3",
    why: "current pin kept",
  });
});

test("with no flag a connector that has no pin yet takes the latest release", () => {
  const args = parsePinArguments([], KEYS);
  assert.equal(choosePin({ connectorKey: "codex", args, hold: undefined, currentVersion: undefined }).kind, "latest");
});

test("--latest moves an unheld connector and leaves a held one where its hold puts it", () => {
  const args = parsePinArguments(["--latest"], KEYS);
  assert.equal(choosePin({ connectorKey: "imessage", args, hold: undefined, currentVersion: "0.1.3" }).kind, "latest");
  const held = choosePin({ connectorKey: "claude-code", args, hold, currentVersion: "0.3.4" });
  assert.deepEqual(held, { kind: "version", version: "0.3.4", why: "held: latest drops a stream" });
});

test("--version names a release and beats a hold", () => {
  const args = parsePinArguments(["--version", "claude-code=0.3.9"], KEYS);
  const choice = choosePin({ connectorKey: "claude-code", args, hold, currentVersion: "0.3.4" });
  assert.equal(choice.kind === "version" && choice.version, "0.3.9");
});

test("an unknown connector key is an error", () => {
  assert.throws(() => parsePinArguments(["--version", "claude_code=0.3.4"], KEYS), /unknown connector "claude_code"/);
});

test("a malformed --version is an error, including a spec with more than one =", () => {
  for (const spec of ["claude-code", "claude-code=", "=0.3.4", "claude-code=0.3.4=0.3.5", ""]) {
    assert.throws(() => parsePinArguments(["--version", spec], KEYS), /exactly <connector-key>=<version>/, spec);
  }
  assert.throws(() => parsePinArguments(["--version"], KEYS), /exactly/);
});

test("an unknown argument and a repeated key are errors", () => {
  assert.throws(() => parsePinArguments(["--lastest"], KEYS), /unknown argument "--lastest"/);
  assert.throws(
    () => parsePinArguments(["--version", "codex=0.3.3", "--version", "codex=0.3.5"], KEYS),
    /names codex twice/
  );
});

test("a hold needs a version and a reason", () => {
  assert.throws(() => parseHolds({ codex: { version: "0.3.3" } }), /needs a non-empty version and reason/);
  assert.throws(() => parseHolds([]), /must be an object/);
});

test("every hold in collection-profile-holds.json names the version this collector pins", () => {
  const holds = parseHolds(
    JSON.parse(readFileSync(new URL("../collection-profile-holds.json", import.meta.url), "utf8"))
  );
  assert.ok(holds.size > 0);
  const pinned = new Map(COLLECTION_PROFILE_PINS.map((pin) => [pin.connectorKey, pin.version]));
  for (const [key, entry] of holds) {
    assert.equal(pinned.get(key), entry.version, `${key} is held at ${entry.version} but pinned at ${pinned.get(key)}`);
  }
});
