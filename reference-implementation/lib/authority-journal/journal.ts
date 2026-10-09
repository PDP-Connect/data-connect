// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The append-only, never-restored authority journal shared by the
 * AI-training lease store and the held-data lifecycle store.
 *
 * One file, opened with O_APPEND and fsynced per entry, gives every entry one
 * total order across all writers on the host. Readers keep a byte offset and
 * read only what was appended since their last read, assigning each entry the
 * same sequence number on every node.
 *
 * The file MUST sit outside every backup-restore path: restoring it would
 * roll back terminal events.
 *
 * PROTOTYPE: experimental lease and held-data lifecycle work, off by default.
 */
import {
  closeSync,
  existsSync,
  fstatSync,
  fsyncSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  statSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { dirname } from "node:path";

/** Every journal entry carries a unique id and a type tag. */
export interface JournalEntryBase {
  t: string;
  id: string;
  grant_id: string;
}

/**
 * Entry types that record a terminal event (Core: Lifecycle durability):
 * lease tombstones, grant endings, erasure instructions, keep elections and
 * credential disables. Acknowledging one requires advancing the
 * loss-detection evidence first.
 */
const TERMINAL_TYPES: ReadonlySet<string> = new Set(["tombstone", "hd_end", "erase", "hd_keep", "hd_cred_disable"]);

/**
 * Loss-detection evidence, kept outside the journal's failure domain (the
 * prototype puts it in the restorable data directory). `bytes` is the journal
 * length after the latest acknowledged terminal event. A journal shorter than
 * that has lost an acknowledged event, even if its epoch survived.
 */
export interface LossEvidence {
  epoch: string;
  bytes: number;
}

const evidencePaths = new Map<string, string>();

/** Bind a journal to its evidence file. Appends of terminal events then advance it. */
export function registerLossEvidence(journalPath: string, evidencePath: string): void {
  evidencePaths.set(journalPath, evidencePath);
}

export function readLossEvidence(evidencePath: string): LossEvidence | null {
  if (!existsSync(evidencePath)) {
    return null;
  }
  const raw = readFileSync(evidencePath, "utf8").trim();
  try {
    const v = JSON.parse(raw) as Partial<LossEvidence>;
    if (typeof v.epoch === "string" && typeof v.bytes === "number") {
      return { epoch: v.epoch, bytes: v.bytes };
    }
  } catch {
    // A bare epoch string (earlier prototype format) covers no position.
  }
  return { epoch: raw, bytes: 0 };
}

/** Durable replace: write a temporary file, fsync it, rename it over the old one, fsync the directory. */
export function writeLossEvidence(evidencePath: string, ev: LossEvidence): void {
  const tmp = `${evidencePath}.tmp`;
  writeFileSync(tmp, JSON.stringify(ev));
  const fd = openSync(tmp, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, evidencePath);
  const dfd = openSync(dirname(evidencePath), "r");
  try {
    fsyncSync(dfd);
  } finally {
    closeSync(dfd);
  }
}

/**
 * False when the journal cannot show it holds every acknowledged terminal
 * event: it is missing, or shorter than the registered evidence says.
 * True when no evidence is registered for it.
 */
export function journalCoversEvidence(journalPath: string): boolean {
  const evidencePath = evidencePaths.get(journalPath);
  if (!evidencePath) {
    return true;
  }
  const ev = readLossEvidence(evidencePath);
  if (!ev) {
    return true;
  }
  if (!existsSync(journalPath)) {
    return false;
  }
  return statSync(journalPath).size >= ev.bytes;
}

export function appendJournalEntry(path: string, entry: JournalEntryBase): void {
  const fd = openSync(path, "a");
  let size = 0;
  try {
    writeSync(fd, `${JSON.stringify(entry)}\n`);
    fsyncSync(fd);
    size = fstatSync(fd).size;
  } finally {
    closeSync(fd);
  }
  // Advance the evidence before the caller acknowledges the terminal event.
  const evidencePath = evidencePaths.get(path);
  if (evidencePath && TERMINAL_TYPES.has(entry.t)) {
    const ev = readLossEvidence(evidencePath);
    if (ev && size > ev.bytes) {
      writeLossEvidence(evidencePath, { epoch: ev.epoch, bytes: size });
    }
  }
}

/**
 * Incremental reader. `refresh` calls `apply` once per new entry, in journal
 * order. A complete line that does not parse may hold a terminal event, so
 * the reader stops there for good: that refresh and every later one throw,
 * and nothing after the bad line is applied. A new reader on the same file
 * throws at the same line.
 */
export class JournalReader<E extends JournalEntryBase = JournalEntryBase> {
  readonly #path: string;
  #offset = 0;
  #seq = 0;
  #remainder = "";
  #failure: Error | null = null;

  constructor(path: string) {
    this.#path = path;
  }

  get path(): string {
    return this.#path;
  }

  refresh(apply: (entry: E, seq: number) => void): void {
    if (this.#failure) {
      throw this.#failure;
    }
    const fd = openSync(this.#path, "a+");
    try {
      const size = fstatSync(fd).size;
      if (size <= this.#offset) {
        return;
      }
      const buf = Buffer.alloc(size - this.#offset);
      readSync(fd, buf, 0, buf.length, this.#offset);
      this.#offset = size;
      const text = this.#remainder + buf.toString("utf8");
      const lines = text.split("\n");
      this.#remainder = lines.pop() ?? "";
      for (const line of lines) {
        if (line.trim().length === 0) {
          continue;
        }
        let e: E;
        try {
          e = JSON.parse(line) as E;
        } catch {
          this.#failure = new Error(`authority journal ${this.#path}: unreadable entry after sequence ${this.#seq}`);
          throw this.#failure;
        }
        this.#seq += 1;
        apply(e, this.#seq);
      }
    } finally {
      closeSync(fd);
    }
  }
}
