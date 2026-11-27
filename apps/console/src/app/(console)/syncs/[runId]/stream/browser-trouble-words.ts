// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { STREAM_REACH_MESSAGE } from "./stream-reach-diagnostics.ts";

/** The one sentence for a browser DataConnect cannot reach, wherever the cause came from. */
export const COULDNT_REACH_BROWSER = "Couldn't reach the browser.";

/** What a lost browser means for the sign-in. */
export const LOST_BROWSER_MEANS = "The sign-in can't go on until the browser is back.";

/** Every sentence the sign-in helper itself writes about a browser it cannot use. */
const AUTHORED = new Set<string>([
  COULDNT_REACH_BROWSER,
  "The browser isn't available right now.",
  "This browser session expired. Try again.",
  "The browser opened, but its connection was incomplete.",
  "Couldn't open the browser after several tries.",
  "Opening the browser…",
  "The browser could not start. Try again.",
  "The secure browser viewport could not be applied.",
  ...Object.values(STREAM_REACH_MESSAGE),
]);

/**
 * Words for the owner, from a closed set: a sentence DataConnect wrote passes; anything else (a raw
 * technical message, text a server sent, a status that echoes input) becomes the one plain sentence.
 */
export function plainBrowserTrouble(message: string | null | undefined): string {
  const text = (message ?? "").trim();
  if (AUTHORED.has(text)) return text;
  const unknownBase = STREAM_REACH_MESSAGE.unknown;
  return text.startsWith(`${unknownBase} (error `) ? unknownBase : COULDNT_REACH_BROWSER;
}
