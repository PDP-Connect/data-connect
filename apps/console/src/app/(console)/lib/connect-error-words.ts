// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

const REJECTED = /\b(invalid|rejected|unauthori[sz]ed|forbidden|denied|not accepted|did not accept|incorrect|wrong|expired|401|403)\b/i;
const MISSING = /\b(required|missing|empty|blank)\b/i;
const UNREACHABLE = /\b(failed to fetch|network|timed? ?out|timeout|unreachable|econn|enotfound|503|502|504)\b/i;

/**
 * The words shown for a failed connect step. The server's own message is never shown: it can echo
 * what was typed, including a key. Known causes get an authored sentence; anything else gets one
 * neutral sentence.
 */
export function connectErrorWords(rawMessage: string | null | undefined): string {
  const message = rawMessage ?? "";
  if (REJECTED.test(message)) return "The service did not accept what was entered. Check it and try again.";
  if (MISSING.test(message)) return "A required field was left empty.";
  if (UNREACHABLE.test(message)) return "DataConnect could not reach the service.";
  return "Something went wrong.";
}
