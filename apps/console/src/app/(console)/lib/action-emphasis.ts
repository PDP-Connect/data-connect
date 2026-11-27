// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * One rule for which button is filled. When something needs the person, that action is the
 * page's one filled button and the optional "Add" / "Connect" buttons go quiet; when nothing
 * needs them, the optional button stays filled. "Needs the person" comes from the shared
 * source status (`needsYou`), never a second test.
 */
export function actionEmphasis(anyNeedsPerson: boolean): { needed: "filled"; optional: "filled" | "quiet" } {
  return { needed: "filled", optional: anyNeedsPerson ? "quiet" : "filled" };
}
