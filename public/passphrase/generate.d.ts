// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

export const MIN_PASSWORD_LENGTH: number;
export const PASSPHRASE_WORD_COUNT: number;
export function generatePassphrase(getRandomValues?: (array: Uint32Array) => unknown): string;
export function ownPasswordProblem(password: string): string | null;
