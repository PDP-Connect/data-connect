// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { WORDS } from "./words.js";

/** Matches OWNER_PASSWORD_MIN_LENGTH on the server and in the desktop shell. */
export const MIN_PASSWORD_LENGTH = 15;

export const PASSPHRASE_WORD_COUNT = 4;

/**
 * A uniform integer in [0, limit) from a CSPRNG, by rejection sampling so no
 * value is more likely than another. `getRandomValues` is injected so a test
 * can supply a fixed sequence; the default is `crypto.getRandomValues`.
 */
function randomIndex(limit, getRandomValues) {
  const range = 0x100000000;
  const ceiling = range - (range % limit);
  const buffer = new Uint32Array(1);
  for (;;) {
    getRandomValues(buffer);
    if (buffer[0] < ceiling) return buffer[0] % limit;
  }
}

/**
 * A passphrase of four words joined with hyphens, for example
 * `maple-orbit-canyon-velvet`. Entropy is 4 x log2(2048) = 44 bits, about
 * 25 characters. This is the password for an address reachable from the
 * public internet, which sits behind sign-in throttling, so 44 random bits
 * is out of reach for an online guesser while it stays easy to copy and type.
 * Four BIP-39 words are never shorter than 15 characters (4 x 3 letters plus
 * 3 hyphens); the loop below keeps that true if the word list ever changes.
 */
export function generatePassphrase(getRandomValues = globalThis.crypto.getRandomValues.bind(globalThis.crypto)) {
  for (;;) {
    const words = [];
    for (let i = 0; i < PASSPHRASE_WORD_COUNT; i += 1) {
      words.push(WORDS[randomIndex(WORDS.length, getRandomValues)]);
    }
    const passphrase = words.join("-");
    if (Array.from(passphrase).length >= MIN_PASSWORD_LENGTH) return passphrase;
  }
}

/**
 * The checks the window can run before it asks the shell to save. The length
 * floor is the only rule it enforces; the shell applies the common-password
 * list and is the authority.
 */
export function ownPasswordProblem(password) {
  if (Array.from(password).length < MIN_PASSWORD_LENGTH) {
    return "Use at least 15 characters.";
  }
  return null;
}
