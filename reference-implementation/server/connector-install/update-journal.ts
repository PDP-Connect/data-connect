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
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { resolve } from "node:path";

const JOURNAL_ID = /^[a-zA-Z0-9-]{1,80}$/;

type JournalKind = "plan" | "batch" | "consent";

/**
 * Resolve one journal entry path and prove it stays inside the journal root.
 * The data directory comes from the operator, so the containment proof lives
 * in this function rather than in a literal path: `realpathSync` collapses a
 * symlinked root, the prefix check rejects a candidate that escapes it, and
 * the id pattern keeps an entry name to one path segment.
 */
function connectorUpdateJournalEntryPath(root: string, kind: JournalKind, id: string): string {
  if (!JOURNAL_ID.test(id)) {
    throw Object.assign(new Error("Unknown connector update job."), { code: "not_found", statusCode: 404 });
  }
  const realRoot = realpathSync(root);
  const candidate = resolve(realRoot, `${kind}-${id}.json`);
  if (candidate !== realRoot && !candidate.startsWith(`${realRoot}/`)) {
    throw new Error("Connector update journal entry escapes the journal root.");
  }
  return candidate;
}

function readJournalEntry<T>(root: string, kind: JournalKind, id: string): T | null {
  const path = connectorUpdateJournalEntryPath(root, kind, id);
  if (!existsSync(path)) {
    return null;
  }
  if (!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink()) {
    throw new Error("Invalid update journal entry.");
  }
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

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

  read<T>(kind: JournalKind, id: string): T | null {
    return readJournalEntry<T>(this.root, kind, id);
  }

  write(kind: JournalKind, id: string, value: unknown): void {
    const target = connectorUpdateJournalEntryPath(this.root, kind, id);
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

  ids(kind: JournalKind): string[] {
    return readdirSync(this.root)
      .filter((name) => name.startsWith(`${kind}-`) && name.endsWith(".json"))
      .map((name) => name.slice(kind.length + 1, -5));
  }
}
