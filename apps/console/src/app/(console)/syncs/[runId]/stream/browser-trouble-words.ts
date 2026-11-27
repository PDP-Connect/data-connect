// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/** The one sentence for a browser DataConnect cannot reach, wherever the cause came from. */
export const COULDNT_REACH_BROWSER = "Couldn't reach the browser.";

/** What a lost browser means for the sign-in. */
export const LOST_BROWSER_MEANS = "The sign-in can't go on until the browser is back.";

/** A message that names the machinery (a socket, a protocol, a code) and not what happened. */
const TECHNICAL =
  /failed to fetch|fetch failed|load failed|networkerror|websocket|\bcdp\b|\bsocket\b|econn|enotfound|eai_again|etimedout|\bprotocol\b|\b[a-z0-9]+(?:_[a-z0-9]+)+\b|\bexception\b|\berror:|\bundefined\b|\bHTTP \d{3}\b|\bat \S+:\d+/i;

/**
 * Words for the owner. A message the server authored in plain words passes through; a raw
 * technical one (for example "cdp websocket error") becomes the one plain sentence.
 */
export function plainBrowserTrouble(message: string | null | undefined): string {
  const text = (message ?? "").trim();
  return text === "" || TECHNICAL.test(text) ? COULDNT_REACH_BROWSER : text;
}
