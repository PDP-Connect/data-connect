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

/** The label a field shows: the manifest's own, or a readable form of the field name when it is empty or just the raw name. */
export function fieldLabelWords(label: string | null | undefined, name: string): string {
  const own = (label ?? "").trim();
  if (own && own !== name) return own;
  const spaced = name.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[_\-.]+/g, " ").trim().toLowerCase();
  return spaced ? spaced.charAt(0).toUpperCase() + spaced.slice(1) : "Details";
}
