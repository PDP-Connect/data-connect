// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import { GET } from "./route.ts";

const CHALLENGE = "00112233445566778899aabbccddeeff";

function withKey<T>(key: string | undefined, run: () => T): T {
  const previous = process.env.PDPP_ORIGIN_PROOF_KEY;
  if (key === undefined) {
    delete process.env.PDPP_ORIGIN_PROOF_KEY;
  } else {
    process.env.PDPP_ORIGIN_PROOF_KEY = key;
  }
  try {
    return run();
  } finally {
    if (previous === undefined) {
      delete process.env.PDPP_ORIGIN_PROOF_KEY;
    } else {
      process.env.PDPP_ORIGIN_PROOF_KEY = previous;
    }
  }
}

function probe(challenge: string): Response {
  return GET(new Request(`http://127.0.0.1:3000/api/origin-proof?challenge=${challenge}`));
}

test("answers a challenge with the same HMAC-SHA256 the supervisor computes", async () => {
  // The same key/challenge/proof triple is pinned on the Rust side in
  // `the_console_and_the_supervisor_agree_on_the_proof`, so a divergence
  // between the two implementations fails one of the two suites.
  const response = withKey("this-process-key", () => probe(CHALLENGE));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(
    await response.text(),
    "63cdbd95f7ede15df13f1fc676b443da4e43951477d5fa2da44bfd9f3949fe55"
  );
});

test("never echoes the key", async () => {
  const response = withKey("secret-per-boot-key", () => probe(CHALLENGE));
  assert.doesNotMatch(await response.text(), /secret-per-boot-key/);
});

test("has nothing to prove without a key", () => {
  assert.equal(withKey(undefined, () => probe(CHALLENGE)).status, 404);
});

test("refuses a challenge that is not the supervisor's shape", () => {
  for (const challenge of ["", "short", `${CHALLENGE}00`, "ZZ112233445566778899aabbccddeeff"]) {
    assert.equal(withKey("k", () => probe(challenge)).status, 400, challenge);
  }
});
