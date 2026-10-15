// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { readdirSync, rmSync } from "node:fs";
import { join } from "node:path";

// Kept across a reset: the volume's root-owned lost+found (the app cannot
// delete it), and the Moksha state, which records what is on chain (deposit,
// per-child gateway registrations, the settlement poll's start block) rather
// than walkthrough data. Operator-provided *.env files are kept too.
const KEEP = new Set(["lost+found", "moksha"]);

/** Removes the reminder service's state (and the reset marker) from the state dir. */
export function wipeStateDir(dir: string): void {
  for (const name of readdirSync(dir)) {
    if (!(KEEP.has(name) || name.endsWith(".env"))) {
      rmSync(join(dir, name), { force: true, recursive: true });
    }
  }
}
