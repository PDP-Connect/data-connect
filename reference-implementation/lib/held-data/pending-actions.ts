// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * D4 inbox, independent of the authority history. Keep this file outside the
 * history's failure and restore domain, and its witness outside the inbox's.
 * One Node process serializes intake and recovery in this prototype.
 */
import { createHash, randomUUID } from "node:crypto";
import { closeSync, existsSync, fsyncSync, ftruncateSync, openSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { appendJournalEntry, readLossEvidence, writeLossEvidence } from "../authority-journal/journal.ts";
import type { Disposition, EndingPath, GrantRegistration } from "./authority.ts";

export interface PendingAction {
  id: string;
  grant: GrantRegistration;
  kind: "end" | "elect";
  path: EndingPath;
  disposition: Disposition | null;
  acceptedAt: number;
  erasureId: string | null;
}

type Record =
  | { t: "pending_epoch"; id: string; grant_id: string }
  | { t: "pending_action"; id: string; grant_id: string; action: PendingAction }
  | { t: "pending_applied"; id: string; grant_id: string; actionId: string };

export class PendingActions {
  readonly #path: string;
  readonly #evidencePath: string;

  constructor(path: string, evidencePath: string, initialize: boolean) {
    this.#path = path;
    this.#evidencePath = evidencePath;
    if (initialize && !(existsSync(path) || existsSync(evidencePath))) {
      this.#append({ t: "pending_epoch", id: randomUUID(), grant_id: "" });
    }
  }

  get epoch(): string | null {
    try {
      const first = this.#records()[0];
      return first?.t === "pending_epoch" ? first.id : null;
    } catch {
      return null;
    }
  }

  get lost(): boolean {
    try {
      this.#records();
      return false;
    } catch {
      return true;
    }
  }

  accepted(): PendingAction[] {
    return this.#records().flatMap((r) => (r.t === "pending_action" ? [r.action] : []));
  }

  pending(): PendingAction[] {
    const actions = new Map<string, PendingAction>();
    const applied = new Set<string>();
    for (const r of this.#records()) {
      if (r.t === "pending_action") actions.set(r.action.id, r.action);
      if (r.t === "pending_applied") applied.add(r.actionId);
    }
    return [...actions.values()].filter((a) => !applied.has(a.id));
  }

  accept(input: Omit<PendingAction, "id" | "erasureId">): PendingAction {
    const accepted = this.accepted();
    const existing = accepted.find(
      (a) =>
        a.grant.grantId === input.grant.grantId &&
        a.kind === input.kind &&
        a.path === input.path &&
        a.disposition === input.disposition,
    );
    if (existing) {
      // A previous append may have reached disk before its witness write failed.
      this.#advanceEvidence();
      return existing;
    }
    const covering = accepted.find((a) => a.grant.grantId === input.grant.grantId && a.erasureId);
    const action: PendingAction = {
      ...input,
      id: `hdpending_${randomUUID()}`,
      erasureId: input.disposition === "delete" ? (covering?.erasureId ?? `hdop_${randomUUID()}`) : null,
    };
    this.#append({
      t: "pending_action",
      id: action.id,
      grant_id: action.grant.grantId,
      action,
    });
    return action;
  }

  applied(action: PendingAction): void {
    this.#records();
    this.#append({
      t: "pending_applied",
      id: randomUUID(),
      grant_id: action.grant.grantId,
      actionId: action.id,
    });
  }

  #records(): Record[] {
    const ev = readLossEvidence(this.#evidencePath);
    if (!ev || !Number.isSafeInteger(ev.bytes) || ev.bytes <= 0 || !existsSync(this.#path))
      throw new Error("pending-action history or evidence missing");
    const bytes = readFileSync(this.#path);
    const digest = createHash("sha256").update(bytes.subarray(0, ev.bytes)).digest("hex");
    if (bytes.length < ev.bytes || digest !== ev.epoch || bytes[ev.bytes - 1] !== 10)
      throw new Error("pending-action history lost or corrupt");
    if (bytes.length > ev.bytes) {
      // No record beyond this witness was acknowledged. In particular, an
      // unwitnessed applied marker must never suppress a witnessed intent.
      const fd = openSync(this.#path, "r+");
      try {
        ftruncateSync(fd, ev.bytes);
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
    }
    return bytes
      .subarray(0, ev.bytes)
      .toString("utf8")
      .trim()
      .split("\n")
      .map((line) => {
        const r = JSON.parse(line) as Record;
        if (!(r.t === "pending_epoch" || r.t === "pending_action" || r.t === "pending_applied"))
          throw new Error("unknown pending-action entry");
        if (r.t === "pending_action" && !(r.action?.id === r.id && r.action.grant?.grantId === r.grant_id))
          throw new Error("invalid pending action");
        return r;
      });
  }

  #append(r: Record): void {
    appendJournalEntry(this.#path, r);
    const directory = openSync(dirname(this.#path), "r");
    try {
      fsyncSync(directory);
    } finally {
      closeSync(directory);
    }
    this.#advanceEvidence();
  }

  #advanceEvidence(): void {
    const bytes = readFileSync(this.#path);
    writeLossEvidence(this.#evidencePath, {
      epoch: createHash("sha256").update(bytes).digest("hex"),
      bytes: bytes.length,
    });
  }
}
