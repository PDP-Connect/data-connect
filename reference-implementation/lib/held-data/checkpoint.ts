// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { createHash, randomUUID } from "node:crypto";
import { closeSync, fsyncSync, openSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

/** Synchronous, single-writer storage: a write must be durable before returning. */
export interface ClientCheckpointStorage {
  read: () => string | null;
  write: (checkpoint: string) => void;
}

export class MemoryClientCheckpointStorage implements ClientCheckpointStorage {
  checkpoint: string | null = null;
  /** Independent evidence. Restoring just checkpoint cannot restore this. */
  witness: string | null = null;

  read(): string | null {
    if (this.checkpoint === null && this.witness === null) {
      return null;
    }
    verify(this.checkpoint, this.witness);
    return this.checkpoint;
  }

  write(checkpoint: string): void {
    this.witness = digest(checkpoint);
    this.checkpoint = checkpoint;
  }
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function verify(checkpoint: string | null, witness: string | null): void {
  if (checkpoint === null || witness === null || digest(checkpoint) !== witness) {
    throw new Error("client checkpoint missing, corrupt or rolled back");
  }
}

function readOptional(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

function durableReplace(path: string, value: string): void {
  const temp = `${path}.${randomUUID()}.pending`;
  const fd = openSync(temp, "wx", 0o600);
  try {
    writeFileSync(fd, value);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temp, path);
  const dir = openSync(dirname(path), "r");
  try {
    fsyncSync(dir);
  } finally {
    closeSync(dir);
  }
}

/**
 * The witness MUST live outside the checkpoint's restore/failure domain.
 * Restoring both files cannot be detected without an external trusted anchor.
 * Witness first: a crash between writes leaves a mismatch, never stale authority.
 * Parent directories must already exist. One live client owns these paths.
 */
export class FileClientCheckpointStorage implements ClientCheckpointStorage {
  readonly checkpointPath: string;
  readonly witnessPath: string;

  constructor(checkpointPath: string, witnessPath: string) {
    if (resolve(checkpointPath) === resolve(witnessPath)) {
      throw new Error("client checkpoint needs independent rollback evidence");
    }
    this.checkpointPath = checkpointPath;
    this.witnessPath = witnessPath;
  }

  read(): string | null {
    const checkpoint = readOptional(this.checkpointPath);
    const witness = readOptional(this.witnessPath);
    if (checkpoint === null && witness === null) {
      return null;
    }
    verify(checkpoint, witness);
    return checkpoint;
  }

  write(checkpoint: string): void {
    durableReplace(this.witnessPath, digest(checkpoint));
    durableReplace(this.checkpointPath, checkpoint);
  }
}
