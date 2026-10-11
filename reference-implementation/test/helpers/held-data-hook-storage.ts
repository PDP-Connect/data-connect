// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { MemoryClientCheckpointStorage } from "../../lib/held-data/checkpoint.ts";

/** Checkpoint storage whose write runs a hook afterwards: a slow write, or one that disturbs the clock. */
export class HookStorage extends MemoryClientCheckpointStorage {
  /** Runs after every write while set. */
  afterWrite: (() => void) | null = null;

  override write(checkpoint: string): void {
    super.write(checkpoint);
    this.afterWrite?.();
  }
}
