// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";

const JOURNAL_ID = /^[a-zA-Z0-9-]{1,80}$/;

/** Private owner journal. Atomic replacement preserves a complete prior receipt on interruption. */
export class ConnectorUpdateJournal {
  readonly root: string;
  constructor(dataDir: string) {
    this.root = resolve(dataDir, "connector-updates");
    mkdirSync(this.root, { mode: 0o700, recursive: true });
    if (lstatSync(this.root).isSymbolicLink()) {
      throw new Error("Connector update journal must not be a symbolic link.");
    }
  }

  read<T>(kind: "plan" | "batch" | "consent", id: string): T | null {
    const path = this.path(kind, id);
    if (!existsSync(path)) {
      return null;
    }
    if (!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink()) {
      throw new Error("Invalid update journal entry.");
    }
    return JSON.parse(readFileSync(path, "utf8")) as T;
  }

  write(kind: "plan" | "batch" | "consent", id: string, value: unknown): void {
    const target = this.path(kind, id);
    const temporary = `${target}.${randomUUID()}.tmp`;
    const descriptor = openSync(temporary, "wx", 0o600);
    try {
      writeFileSync(descriptor, JSON.stringify(value));
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
    try {
      renameSync(temporary, target);
    } finally {
      rmSync(temporary, { force: true });
    }
  }

  ids(kind: "plan" | "batch" | "consent"): string[] {
    return readdirSync(this.root)
      .filter((name) => name.startsWith(`${kind}-`) && name.endsWith(".json"))
      .map((name) => name.slice(kind.length + 1, -5));
  }

  private path(kind: "plan" | "batch" | "consent", id: string): string {
    if (!JOURNAL_ID.test(id)) {
      throw Object.assign(new Error("Unknown connector update job."), { code: "not_found", statusCode: 404 });
    }
    return join(this.root, `${kind}-${id}.json`);
  }
}
