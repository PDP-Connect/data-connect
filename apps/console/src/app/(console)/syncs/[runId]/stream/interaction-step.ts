// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

const CODE_PROMPT = /\bcode\b/i;

/**
 * The step line of the helper's instruction panel, taken from what the run is asking the person for.
 * A connector that has the person type the code into the service's own page sends a browser step
 * (`manual_action`), not an `otp` field, so its message is the only place that says it is a code.
 */
export function interactionStepLabel(kind: string | undefined | null, message?: string | null): string {
  return kind === "otp" || (message ? CODE_PROMPT.test(message) : false) ? "Step 2 of 2: enter the security code" : "Step 1 of 2: sign in";
}
