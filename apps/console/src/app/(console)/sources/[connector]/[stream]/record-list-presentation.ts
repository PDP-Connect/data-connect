// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import type { CanonicalReadWarning } from "../../../lib/read-envelope.ts";

export function partialReadSentence(warnings: readonly CanonicalReadWarning[]): string | null {
  return warnings.some((warning) => warning.code === "partial_results") ? "Some records could not be read." : null;
}
