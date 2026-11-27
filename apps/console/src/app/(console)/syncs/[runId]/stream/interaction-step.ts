// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/** The step line of the helper's instruction panel, taken from what the run is asking the person for. */
export function interactionStepLabel(kind: string | undefined | null): string {
  return kind === "otp" ? "Step 2 of 2: enter the security code" : "Step 1 of 2: sign in";
}
