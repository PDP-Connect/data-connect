// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
// The one way a settings button copies text. It awaits the write and returns what
// happened, so a refused write or a missing clipboard is never silent. Every copy
// button renders the outcome with `copyFailureLine`, so their words cannot drift.

export type CopyOutcome = "copied" | "unavailable" | "failed";

/** Writes `text` to the clipboard. Never throws. */
export async function copyText(text: string): Promise<CopyOutcome> {
  const clipboard = typeof navigator === "undefined" ? undefined : navigator.clipboard;
  if (!clipboard) return "unavailable";
  try {
    await clipboard.writeText(text);
    return "copied";
  } catch {
    return "failed";
  }
}

/** What to tell the owner when a copy did not happen; null when it did. */
export function copyFailureLine(outcome: CopyOutcome): string | null {
  if (outcome === "unavailable") return "Clipboard unavailable. Copy the text by hand.";
  if (outcome === "failed") return "Couldn't copy to the clipboard. Copy the text by hand.";
  return null;
}
