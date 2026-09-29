// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// DR demo: when "Mis autorizaciones" was last reset, as one ISO timestamp in
// a file next to the database, so it survives restarts on the same volume.
//
//   /var/lib/pdpp/pdpp.sqlite
//   /var/lib/pdpp/citizen-demo-reset-at   "2026-09-29T14:03:11.000Z"

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const RESET_FILE = "citizen-demo-reset-at";

export interface CitizenResetStore {
  read: () => Promise<string | null>;
  write: (iso: string) => Promise<void>;
}

export function createCitizenResetStore(dataDir: string): CitizenResetStore {
  const file = path.join(dataDir, RESET_FILE);
  return {
    read: async () => {
      const text = await readFile(file, "utf8").catch(() => "");
      return text.trim() || null;
    },
    write: async (iso) => {
      await mkdir(dataDir, { recursive: true });
      await writeFile(file, iso, "utf8");
    },
  };
}
