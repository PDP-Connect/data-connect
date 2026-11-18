// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import { randomUUID } from "node:crypto";
import { mkdir, open, readdir, readFile, rename } from "node:fs/promises";
import { join } from "node:path";
import type { Handle, RouteView as Route } from "@tnunamak/gozar";
import { ReachabilityError } from "./approvals.ts";
import type { projectRoute } from "./projection.ts";

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
    if (record.stage === "applying" && !this.running.has(operationId)) {
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
  async list(): Promise<OperationRecord[]> {
    let names: string[];
    try {
      names = await readdir(this.root);
    } catch (error) {
      if ((error as { code?: string }).code === "ENOENT") {
        return [];
      }
      throw error;
    }
    const records = [];
    for (const name of names) {
      if (/^[a-f0-9-]{36}\.json$/.test(name)) {
        records.push(await this.read(name.slice(0, -5)));
      }
    }
    return records;
  }
  async recordRecovered(operationId: string, route: Route): Promise<void> {
    const record = await this.read(operationId);
    await this.write({ ...record, handle: route.handle, recovery: null, route: null, stage: "settled" });
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
    // Durable intent precedes the first library effect and the 202 response.
    await this.write(pending);
    this.running.add(operationId);
    void (async () => {
      // Set once the effect has returned: a later settlement-write failure must
      // not drop the handle the effect already allocated.
      let allocated: Handle | null = null;
      try {
        const route = await effect(operationId);
        allocated = route.handle;
        await this.write({ ...pending, handle: route.handle, route: null, stage: "settled" });
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
        await this.write({
          ...pending,
          handle: allocated ?? partial?.handle ?? pending.handle,
          failureCode,
          recovery: {
            available: this.recoveryAvailable,
            reason: this.recoveryAvailable ? "route_reconciliation_required" : "public_operation_recovery_unavailable",
          },
          stage: "unknown-possibly-live",
        });
      } finally {
        this.running.delete(operationId);
      }
    })().catch(() => {
      this.running.delete(operationId);
    });
    return { operationId };
  }
}
