// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import { randomUUID } from "node:crypto";
import { mkdir, open, readdir, readFile, rename } from "node:fs/promises";
import { join } from "node:path";
import type { Handle, RouteView as Route } from "@tnunamak/gozar";
import { ReachabilityError } from "./approvals.ts";
import type { projectRoute } from "./projection.ts";

/** The one handle identity: a handle is the whole of kind, id and generation. Key per-handle state by it. */
export function handleKey(handle: Handle): string {
  return JSON.stringify([handle.kind, handle.id, handle.generation]);
}
export function sameHandle(a: Handle, b: Handle): boolean {
  return handleKey(a) === handleKey(b);
}

export type OperationRecord = {
  intent: {
    instanceId: string;
    bootId: string;
    providerId: string;
    configurationRevision: string;
    target: string;
    usage: import("@tnunamak/gozar").Usage;
    expectedOrigin: string | null;
    ownership?: Route["ownership"];
    consentFactsDigest: string;
  } | null;
  operationId: string;
  kind: "start" | "stop" | "check";
  stage: "applying" | "settled" | "unknown-possibly-live";
  stopTombstone: boolean;
  /**
   * Cleanup evidence: true only where a close confirmed, or the library reported the
   * route absent. A Stop intent (tombstone) is not evidence. Absent on older records,
   * which the restart pass treats as not confirmed.
   */
  cleanupConfirmed?: boolean;
  failureCode: string | null;
  handle: Handle | null;
  route: ReturnType<typeof projectRoute> | null;
  recovery: {
    available: boolean;
    reason: "public_operation_recovery_unavailable" | "route_reconciliation_required";
  } | null;
};

// Only non-secret operation metadata is journaled here. Gozar retains its own
// receipts. The host never scans or rewrites the library's private home.
export class ReachabilityOperations {
  private readonly root: string;
  private readonly running = new Set<string>();
  // Tail of the write chain per record. Every read-modify-write of one record queues here,
  // so independent writers (boot pass, owner retry, shutdown) cannot interleave.
  private readonly tails = new Map<string, Promise<unknown>>();
  constructor(root: string, privateRecoveryAvailable = false) {
    this.root = root;
    this.recoveryAvailable = privateRecoveryAvailable;
  }
  private readonly recoveryAvailable: boolean;
  private path(id: string): string {
    if (!/^[a-f0-9-]{36}$/.test(id)) {
      throw new ReachabilityError("operation_not_found");
    }
    return join(this.root, `${id}.json`);
  }
  private serialized<T>(operationId: string, task: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(operationId) ?? Promise.resolve();
    const run = previous.then(task, task);
    const tail = run.then(
      () => undefined,
      () => undefined
    );
    this.tails.set(operationId, tail);
    void tail.then(() => {
      if (this.tails.get(operationId) === tail) this.tails.delete(operationId);
    });
    return run;
  }
  private async write(record: OperationRecord): Promise<void> {
    await mkdir(this.root, { mode: 0o700, recursive: true });
    const path = this.path(record.operationId);
    const temporary = `${path}.${randomUUID()}.pending`;
    const file = await open(temporary, "w", 0o600);
    try {
      await file.writeFile(`${JSON.stringify(record)}\n`);
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temporary, path);
    const directory = await open(this.root, "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  }
  async read(operationId: string): Promise<OperationRecord> {
    // Sampled before the file is read: a start that finishes while this read is
    // in flight writes its settled record and only then leaves `running`, so a
    // stale "applying" copy must not be mistaken for an orphan.
    const runningBefore = this.running.has(operationId);
    let record: OperationRecord;
    try {
      record = JSON.parse(await readFile(this.path(operationId), "utf8")) as OperationRecord;
    } catch {
      throw new ReachabilityError("operation_not_found");
    }
    try {
      await readFile(`${this.path(operationId)}.stop`);
      record.stopTombstone = true;
    } catch (error) {
      if ((error as { code?: string }).code !== "ENOENT") throw error;
    }
    if (record.operationId !== operationId) {
      throw new ReachabilityError("operation_not_found");
    }
    if (record.stage === "applying" && !runningBefore && !this.running.has(operationId)) {
      // An unrecorded handle does not prove no route was created. Do not replay.
      record = {
        ...record,
        recovery: {
          available: this.recoveryAvailable,
          reason: this.recoveryAvailable ? "route_reconciliation_required" : "public_operation_recovery_unavailable",
        },
        stage: "unknown-possibly-live",
      };
      await this.write(record);
    }
    return record;
  }
  async requestStop(operationId: string): Promise<void> {
    await this.read(operationId);
    // Separate monotonic tombstone: a late start completion cannot overwrite it.
    const file = await open(`${this.path(operationId)}.stop`, "a", 0o600);
    try {
      await file.sync();
    } finally {
      await file.close();
    }
    const directory = await open(this.root, "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  }
  // The stop tombstone stays and the record says the route may still be live,
  // so a later boot reconciles it instead of trusting a close that never confirmed.
  // A confirmed or absent outcome is final: a weaker write that arrives later, from any
  // path, leaves the record as it is.
  async recordCleanupUnconfirmed(operationId: string, handle: Handle): Promise<void> {
    await this.serialized(operationId, async () => {
      const record = await this.read(operationId);
      if (record.cleanupConfirmed === true) return;
      await this.write({
        ...record,
        cleanupConfirmed: false,
        failureCode: record.failureCode ?? "reachability_unavailable",
        handle,
        recovery: {
          available: this.recoveryAvailable,
          reason: this.recoveryAvailable ? "route_reconciliation_required" : "public_operation_recovery_unavailable",
        },
        stage: "unknown-possibly-live",
      });
    });
  }
  /**
   * Every write that settles a start or stop from its own effect goes through here. The effect
   * may finish after another path recorded stronger evidence, so the write merges against the
   * record on disk (read inside the queue): a confirmed or absent outcome for the same handle is
   * final, and an explicit unconfirmed record is replaced only by a confirmation.
   */
  private async merged(next: OperationRecord): Promise<OperationRecord> {
    const prior = await this.read(next.operationId).catch(() => null);
    if (!prior || prior.operationId !== next.operationId) return next;
    if (prior.handle && next.handle && !sameHandle(prior.handle, next.handle)) return next;
    if (prior.cleanupConfirmed === true) return { ...prior, handle: prior.handle ?? next.handle };
    if (prior.cleanupConfirmed === false && next.cleanupConfirmed !== true) return prior;
    return next;
  }
  async list(): Promise<OperationRecord[]> {
    return (await this.scan()).records;
  }
  /** Every readable record, plus how many matching records could not be read. */
  async scan(): Promise<{ records: OperationRecord[]; unreadable: number }> {
    let names: string[];
    try {
      names = await readdir(this.root);
    } catch (error) {
      if ((error as { code?: string }).code === "ENOENT") {
        return { records: [], unreadable: 0 };
      }
      throw error;
    }
    const records: OperationRecord[] = [];
    let unreadable = 0;
    for (const name of names) {
      if (/^[a-f0-9-]{36}\.json$/.test(name)) {
        try {
          records.push(await this.read(name.slice(0, -5)));
        } catch {
          unreadable += 1;
        }
      }
    }
    return { records, unreadable };
  }
  async recordRecovered(operationId: string, route: Route): Promise<void> {
    await this.serialized(operationId, async () => {
      const record = await this.read(operationId);
      await this.write({
        ...record,
        cleanupConfirmed: record.cleanupConfirmed === true || route.cleanup.state === "confirmed",
        handle: route.handle,
        recovery: null,
        route: null,
        stage: "settled",
      });
    });
  }
  /** The library has no route under the record's handle, so nothing of it can still be live. */
  async recordAbsent(operationId: string): Promise<void> {
    await this.serialized(operationId, async () => {
      const record = await this.read(operationId);
      await this.write({ ...record, cleanupConfirmed: true, recovery: null, route: null, stage: "settled" });
    });
  }
  async start(
    kind: OperationRecord["kind"],
    handle: Handle | null,
    effect: (operationId: string) => Promise<Route>,
    intent: OperationRecord["intent"] = null
  ): Promise<{ operationId: string }> {
    const operationId = randomUUID();
    const pending: OperationRecord = {
      failureCode: null,
      handle,
      intent,
      kind,
      operationId,
      recovery: null,
      route: null,
      stage: "applying",
      stopTombstone: kind === "stop",
    };
    // Durable intent precedes the first library effect and the 202 response. The
    // operation counts as running before its record exists, so no read sees the
    // new "applying" record as a crash orphan.
    this.running.add(operationId);
    try {
      await this.write(pending);
    } catch (error) {
      this.running.delete(operationId);
      throw error;
    }
    void (async () => {
      // Set once the effect has returned: a later settlement-write failure must
      // not drop the handle the effect already allocated.
      let allocated: Handle | null = null;
      try {
        const route = await effect(operationId);
        allocated = route.handle;
        await this.serialized(operationId, async () => this.write(await this.merged({
          ...pending,
          ...(kind === "stop" ? { cleanupConfirmed: route.cleanup?.state === "confirmed" } : {}),
          handle: route.handle,
          route: null,
          stage: "settled",
        })));
      } catch (error) {
        const partial = error && typeof error === "object" && "route" in error
          ? (error as { route?: { handle?: Handle } | null }).route
          : null;
        const known = new Set([
          "host_policy_denied",
          "artifact_integrity_failed",
          "requirements_unsatisfied",
          "consent_required",
          "consent_unknown",
          "consent_changed",
          "consent_expired",
          "consent_mismatch",
          "configuration_stale",
          "configuration_in_use",
          "verification_failed",
          "unsupported",
          "provider_unavailable",
          "operation_conflict",
        ]);
        const supplied = error && typeof error === "object" && "code" in error ? error.code : null;
        const failureCode = typeof supplied === "string" && known.has(supplied) ? supplied : "reachability_unavailable";
        // The record keeps only a public code. Log the original class and message
        // (never the object, which can carry route or secret fields) so a masked
        // failure stays diagnosable.
        const original = error instanceof Error ? error : null;
        console.error(
          `[reachability] operation ${operationId} (${kind}) failed: code=${typeof supplied === "string" ? supplied : "none"} ` +
          `name=${original?.name ?? typeof error} message=${(original?.message ?? "").slice(0, 300)}`
        );
        await this.serialized(operationId, async () => this.write(await this.merged({
          ...pending,
          handle: allocated ?? partial?.handle ?? pending.handle,
          failureCode,
          recovery: {
            available: this.recoveryAvailable,
            reason: this.recoveryAvailable ? "route_reconciliation_required" : "public_operation_recovery_unavailable",
          },
          stage: "unknown-possibly-live",
        })));
      } finally {
        this.running.delete(operationId);
      }
    })().catch(() => {
      this.running.delete(operationId);
    });
    return { operationId };
  }
}
