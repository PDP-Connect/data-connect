// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * One name for what a source saved, in every sentence that mentions it. A saved username and
 * password is "sign-in details"; any other saved secret is "a key" (the same rule the first-sync
 * page uses for "Enter the key again").
 */
export function savedSecretNoun(credentialKind: string | null | undefined): "key" | "sign-in details" {
  return credentialKind === "username_password" ? "sign-in details" : credentialKind ? "key" : "sign-in details";
}

/** The button that puts the saved secret in again. */
export function savedSecretUpdateLabel(credentialKind: string | null | undefined): string {
  return savedSecretNoun(credentialKind) === "key" ? "Enter the key again" : "Update sign-in details";
}

/** The saved secret as one word in "Your records and <word> are kept." */
export function keptSecretWord(credentialKind: string | null | undefined): "key" | "sign-in" {
  return savedSecretNoun(credentialKind) === "key" ? "key" : "sign-in";
}
