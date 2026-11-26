// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import type { LocalCollectorTemplate } from "./local-collector-support.ts";
import { listOwnerConnectorTemplates } from "./rs-client.ts";

/**
 * Loads the owner connector templates the enrollment surfaces decide from.
 * Returns null when the server cannot be read, so a caller can tell "no
 * connector can be enrolled" apart from "the answer is unknown".
 */
export async function loadLocalCollectorTemplates(): Promise<readonly LocalCollectorTemplate[] | null> {
  try {
    return await listOwnerConnectorTemplates();
  } catch {
    return null;
  }
}
