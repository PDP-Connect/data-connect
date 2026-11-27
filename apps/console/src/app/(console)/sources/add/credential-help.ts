// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

const SENTENCE_END = /(?<=[.!?])\s+(?=[A-Z])/;

/**
 * A manifest's help text for a field can be a paragraph of how-to. The field shows its first
 * sentence; the rest goes behind a disclosure. A generic rule: no connector is special-cased.
 */
export function splitHelpText(text: string): { more: string | null; short: string } {
  const [first = text, ...rest] = text.trim().split(SENTENCE_END);
  return { more: rest.length ? rest.join(" ") : null, short: first };
}
