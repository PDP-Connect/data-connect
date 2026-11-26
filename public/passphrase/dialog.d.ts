// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

export function mountOwnerPasswordDialog(
  document: Document,
  options: {
    invoke?: (command: string, args: { password: string }) => Promise<unknown>;
    clipboard?: { writeText: (text: string) => Promise<void> };
    generate?: () => string;
  }
): void;
