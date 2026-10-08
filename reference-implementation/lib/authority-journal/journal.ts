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
import { closeSync, fstatSync, fsyncSync, openSync, readSync, writeSync } from "node:fs";

/** Every journal entry carries a unique id and a type tag. */
export interface JournalEntryBase {
  t: string;
  id: string;
  grant_id: string;
}

export function appendJournalEntry(path: string, entry: JournalEntryBase): void {
  const fd = openSync(path, "a");
  try {
    writeSync(fd, `${JSON.stringify(entry)}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/** Incremental reader. `refresh` calls `apply` once per new entry, in journal order. */
export class JournalReader<E extends JournalEntryBase = JournalEntryBase> {
  readonly #path: string;
  #offset = 0;
  #seq = 0;
  #remainder = "";

  constructor(path: string) {
    this.#path = path;
  }

  get path(): string {
    return this.#path;
  }

  refresh(apply: (entry: E, seq: number) => void): void {
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
          continue;
        }
        this.#seq += 1;
        apply(e, this.#seq);
      }
    } finally {
      closeSync(fd);
    }
  }
}
