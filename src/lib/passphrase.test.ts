// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
  generatePassphrase,
  MIN_PASSWORD_LENGTH,
  ownPasswordProblem,
  PASSPHRASE_WORD_COUNT,
} from "../../public/passphrase/generate.js";
import { WORDS } from "../../public/passphrase/words.js";

describe("generatePassphrase", () => {
  it("returns four words from the list, at least 15 characters", () => {
    const passphrase = generatePassphrase();
    const parts = passphrase.split("-");
    expect(parts).toHaveLength(PASSPHRASE_WORD_COUNT);
    for (const part of parts) expect(WORDS).toContain(part);
    expect(Array.from(passphrase).length).toBeGreaterThanOrEqual(MIN_PASSWORD_LENGTH);
  });

  it("reads its randomness from the injected source and nowhere else", () => {
    let calls = 0;
    const fixed = (array: Uint32Array) => {
      array[0] = calls * 2048; // maps to index 0 every time
      calls += 1;
    };
    expect(generatePassphrase(fixed)).toBe(Array(4).fill(WORDS[0]).join("-"));
    expect(calls).toBe(4);
  });

  it("does not repeat across many draws with the real source", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 2000; i += 1) seen.add(generatePassphrase());
    expect(seen.size).toBe(2000);
  });

  it("has a list of 2048 distinct lower-case words", () => {
    expect(WORDS).toHaveLength(2048);
    expect(new Set(WORDS).size).toBe(2048);
    for (const word of WORDS) expect(word).toMatch(/^[a-z]{3,8}$/u);
  });
});

describe("ownPasswordProblem", () => {
  it("enforces the 15-character floor only", () => {
    expect(ownPasswordProblem("short")).toMatch(/^At least 15 characters\.$/u);
    expect(ownPasswordProblem("a".repeat(14))).not.toBeNull();
    expect(ownPasswordProblem("a".repeat(15))).toBeNull();
    expect(ownPasswordProblem("a".repeat(200))).toBeNull();
    expect(ownPasswordProblem("alllowercaseletters")).toBeNull();
  });
});
