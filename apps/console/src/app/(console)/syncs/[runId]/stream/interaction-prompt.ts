// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

export function normalizeInteractionPrompt(message: string, fallback: string): string {
  return message.replace(/\s+/g, " ").trim() || fallback;
}
