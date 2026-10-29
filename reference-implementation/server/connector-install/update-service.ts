// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { createHash, randomUUID } from "node:crypto";
import { setTimeout as pause } from "node:timers/promises";
import {
  assertConnectorLifecycleAvailable,
  markConnectorLifecycleRecoveryRequired,
  withConnectorLifecycleLock,
} from "../connector-lifecycle-lock.ts";
import { tryAcquireDirectoryLock } from "./directory-lock.ts";
import type { ConnectorCatalogEntry, ConnectorInstallRecord } from "./index.ts";
import { ConnectorUpdateJournal } from "./update-journal.ts";

export interface ConnectorUpdateItem {
  affected_instance_count: number;
  auto_eligible: false;
  connector_id: string;
  display_name?: string;
  installed: { version: string | null; digest: string };
  manifest_diff: {
    added_fields: string[];
    changed_fields: string[];
    compatibility: "unknown";
    removed_fields: string[];
  };
  manual_eligible: boolean;
  reasons: string[];
  review_required: boolean;
  target: { version: string | null; digest: string };
}
export interface ConnectorUpdatePlan {
  catalog_revision: string | null;
  created_at: string;
  error?: string;
  expires_at: string;
  items: ConnectorUpdateItem[];
  manual_count: number;
  plan_id: string;
  review_count: number;
  state: "checking" | "ready" | "failed";
}
export type UpdateItemState =
  | "queued"
  | "verified"
  | "waiting_for_run_boundary"
  | "activating"
  | "succeeded"
  | "deferred"
  | "failed"
  | "recovery_required";
export interface ConnectorUpdateBatchItem {
  connector_id: string;
  display_name?: string;
  error?: { code: string; message: string };
  installed: ConnectorUpdateItem["installed"];
  retry_eligible: boolean;
  state: UpdateItemState;
  target: ConnectorUpdateItem["target"];
}
export interface ConnectorUpdateBatch {
  batch_id: string;
  completed_at?: string;
  created_at: string;
  idempotency_key: string;
  items: ConnectorUpdateBatchItem[];
  plan_id: string;
  state: "queued" | "running" | "completed" | "completed_with_issues";
}
interface StoredPlan extends ConnectorUpdatePlan {
  installed_revision: string | null;
  prepared: Record<string, ConnectorInstallRecord>;
}
interface UpdateConsent {
  connector_id: string;
  consumed_batch_id: string | null;
  item_fingerprint: string;
  plan_id: string;
  target_digest: string;
}
export interface ConnectorUpdateDependencies {
  /** Called with the existing lifecycle lock held; must fence uncertain publication. */
  activate: (record: ConnectorInstallRecord) => Promise<ConnectorInstallRecord>;
  affectedInstances: (connectorId: string) => Promise<number>;
  afterActivate?: (record: ConnectorInstallRecord) => void;
  catalog: () => Promise<readonly ConnectorCatalogEntry[]>;
  catalogGeneration: () => Promise<string | null>;
  completePublication?: (connectorId: string) => void;
  dataDir: string;
  /**
   * Publishes the catalog's latest verified target through the direct installer
   * path. `updateOne` uses it for a connector with no verified install record: a
   * registration carried over from the pre-OCI bundle has a manifest to replace
   * but no installed tuple for a plan item to diff.
   */
  directUpdate: (connectorId: string) => Promise<ConnectorInstallRecord>;
  hasActiveRuns: (connectorId: string) => Promise<boolean>;
  installed: () => Promise<readonly ConnectorInstallRecord[]>;
  now?: () => number;
  onChanged?: () => void;
  prepare: (entry: ConnectorCatalogEntry) => Promise<ConnectorInstallRecord>;
  runBoundaryTimeoutMs?: number;
  selectedLocalIds: () => Promise<readonly string[]>;
}

function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, next: unknown) => {
    if (!next || typeof next !== "object" || Array.isArray(next)) {
      return next;
    }
    return Object.fromEntries(Object.entries(next).sort(([left], [right]) => left.localeCompare(right)));
  });
}
function fingerprint(value: unknown): string {
  return createHash("sha256").update(canonical(value)).digest("hex");
}
function failure(statusCode: number, code: string, errorMessage: string): Error & { statusCode: number; code: string } {
  return Object.assign(new Error(errorMessage), { code, statusCode });
}
function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const STABLE_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const PRERELEASE_VERSION = /^\d+\.\d+\.\d+-[0-9A-Za-z.-]+(?:\+[0-9A-Za-z.-]+)?$/;

/** Stable releases only. Unknown, prerelease, republished and backward targets require review. */
export function classifyConnectorVersion(installed: string | null, target: string | null): string | null {
  const from = installed?.match(STABLE_VERSION);
  const to = target?.match(STABLE_VERSION);
  if (target && PRERELEASE_VERSION.test(target)) {
    return "prerelease_version";
  }
  if (!(from && to)) {
    return "incomparable_version";
  }
  const left = from.slice(1, 4).map(BigInt);
  const right = to.slice(1, 4).map(BigInt);
  let comparison = 0;
  for (let index = 0; index < 3; index += 1) {
    const oldPart = left[index] ?? 0n;
    const nextPart = right[index] ?? 0n;
    if (nextPart !== oldPart) {
      comparison = nextPart > oldPart ? 1 : -1;
      break;
    }
  }
  if (comparison < 0) {
    return "downgrade";
  }
  if (comparison === 0) {
    return "same_version_republish";
  }
  return left[0] === right[0] ? null : "major_version";
}

function listMemberName(value: unknown): string {
  return value && typeof value === "object" && "name" in value ? String(value.name) : canonical(value);
}

function collectListChanges(before: unknown[], after: unknown[], path: string, added: string[], removed: string[]) {
  const old = new Map(before.map((value) => [listMemberName(value), value]));
  const current = new Map(after.map((value) => [listMemberName(value), value]));
  for (const [name, value] of current) {
    if (!old.has(name)) {
      added.push(`${path}[${name}]`);
    } else {
      collectFieldChanges(old.get(name), value, `${path}[${name}]`, added, removed);
    }
  }
  for (const name of old.keys()) {
    if (!current.has(name)) {
      removed.push(`${path}[${name}]`);
    }
  }
}

function collectFieldChanges(before: unknown, after: unknown, path: string, added: string[], removed: string[]) {
  if (before === undefined) {
    added.push(path);
    return;
  }
  if (after === undefined) {
    removed.push(path);
    return;
  }
  if (Array.isArray(before) && Array.isArray(after)) {
    collectListChanges(before, after, path, added, removed);
    return;
  }
  if (before && after && typeof before === "object" && typeof after === "object") {
    const old = before as Record<string, unknown>;
    const current = after as Record<string, unknown>;
    for (const key of new Set([...Object.keys(old), ...Object.keys(current)])) {
      collectFieldChanges(old[key], current[key], `${path}.${key}`, added, removed);
    }
  }
}

/** Conservative comparison of known declarations; absent compatibility remains unknown. */
function manifestChanges(
  previous: Record<string, unknown>,
  next: Record<string, unknown>
): ConnectorUpdateItem["manifest_diff"] {
  const descriptive = new Set([
    "version",
    "name",
    "display_name",
    "description",
    "logo",
    "icon",
    "homepage",
    "license",
    "connector_id",
    "connector_key",
  ]);
  const changed_fields = [...new Set([...Object.keys(previous), ...Object.keys(next)])]
    .sort()
    .filter((field) => !descriptive.has(field))
    .filter((field) => canonical(previous[field] ?? null) !== canonical(next[field] ?? null));
  const added_fields: string[] = [];
  const removed_fields: string[] = [];
  for (const field of changed_fields) {
    collectFieldChanges(previous[field], next[field], field, added_fields, removed_fields);
  }
  return {
    added_fields: added_fields.sort(),
    changed_fields,
    compatibility: "unknown",
    removed_fields: removed_fields.sort(),
  };
}
function publicPlan(plan: StoredPlan): ConnectorUpdatePlan {
  const { prepared: _prepared, installed_revision: _installed, ...result } = plan;
  return result;
}
const terminal = (item: ConnectorUpdateBatchItem) =>
  ["succeeded", "deferred", "failed", "recovery_required"].includes(item.state);

export function createConnectorUpdateService(deps: ConnectorUpdateDependencies) {
  const journal = new ConnectorUpdateJournal(deps.dataDir);
  const now = deps.now ?? Date.now;
  const running = new Map<string, Promise<void>>();
  let implementationChanged: () => void = () => undefined;
  const planUrl = (id: string) => `/v1/owner/connector-updates/plans/${id}`;
  const batchUrl = (id: string) => `/v1/owner/connector-updates/batches/${id}`;
  const requiredPlan = (id: string) => {
    const plan = journal.read<StoredPlan>("plan", id);
    if (!plan) {
      throw failure(404, "not_found", "Unknown connector update plan.");
    }
    return plan;
  };
  const requiredBatch = (id: string) => {
    const batch = journal.read<ConnectorUpdateBatch>("batch", id);
    if (!batch) {
      throw failure(404, "not_found", "Unknown connector update batch.");
    }
    return batch;
  };
  const snapshot = async () => {
    const entries = await deps.catalog();
    const generation = await deps.catalogGeneration();
    const installed = await deps.installed();
    const locals = [...(await deps.selectedLocalIds())].sort();
    return {
      catalogRevision: fingerprint({
        entries: [...entries].sort((left, right) => canonical(left).localeCompare(canonical(right))),
        generation,
      }),
      entries,
      installed,
      installedRevision: fingerprint({
        installed: [...installed].sort((left, right) => left.connectorId.localeCompare(right.connectorId)),
        locals,
      }),
      locals,
    };
  };
  const background = (key: string, work: () => Promise<void>) => {
    if (running.has(key)) {
      return;
    }
    const promise = work().catch((error: unknown) => {
      console.error(`[connector-updates] ${key}: ${message(error)}`);
    });
    running.set(key, promise);
    promise.finally(() => {
      if (running.get(key) === promise) {
        running.delete(key);
      }
    });
  };
  const build = async (id: string) => {
    const lock = tryAcquireDirectoryLock(journal.root, `plan-${id}`);
    if (!lock) {
      return;
    }
    try {
      const plan = requiredPlan(id);
      try {
        if (plan.state !== "checking") {
          return;
        }
        const captured = await snapshot();
        plan.catalog_revision = captured.catalogRevision;
        plan.installed_revision = captured.installedRevision;
        for (const installed of captured.installed) {
          if (captured.locals.includes(installed.connectorId)) {
            continue;
          }
          const candidates = captured.entries.filter(
            (candidate) => candidate.connector_id === installed.connectorId && candidate.latest
          );
          if (candidates.length !== 1) {
            continue;
          }
          const [entry] = candidates;
          if (!entry) {
            continue;
          }
          if (entry.digest === installed.digest) {
            continue;
          }
          const reason = classifyConnectorVersion(installed.version, entry.version ?? null);
          const item: ConnectorUpdateItem = {
            affected_instance_count: await deps.affectedInstances(installed.connectorId),
            auto_eligible: false,
            connector_id: installed.connectorId,
            ...(entry.display_name || typeof installed.manifest.display_name === "string"
              ? { display_name: entry.display_name ?? String(installed.manifest.display_name) }
              : {}),
            installed: { digest: installed.digest, version: installed.version },
            manifest_diff: { added_fields: [], changed_fields: [], compatibility: "unknown", removed_fields: [] },
            manual_eligible: false,
            reasons: reason ? [reason, "compatibility_not_declared"] : ["compatibility_not_declared"],
            review_required: reason !== null,
            target: { digest: entry.digest, version: entry.version ?? null },
          };
          try {
            const prepared = await deps.prepare(entry);
            if (prepared.digest !== entry.digest || prepared.version !== (entry.version ?? null)) {
              throw new Error("Preflight target identity changed.");
            }
            item.manifest_diff = manifestChanges(installed.manifest, prepared.manifest);
            if (canonical(installed.bindings) !== canonical(prepared.bindings)) {
              item.manifest_diff.changed_fields.push("bindings");
            }
            if (item.manifest_diff.changed_fields.length) {
              item.review_required = true;
              item.reasons.push("manifest_changed");
            }
            item.manual_eligible = !item.review_required;
            plan.prepared[item.connector_id] = prepared;
          } catch (error) {
            item.reasons.push("verification_failed", message(error));
            item.manual_eligible = false;
            item.review_required = true;
          }
          plan.items.push(item);
        }
        plan.manual_count = plan.items.filter((item) => item.manual_eligible).length;
        plan.review_count = plan.items.filter((item) => item.review_required).length;
        plan.state = "ready";
      } catch (error) {
        plan.state = "failed";
        plan.error = message(error);
      } finally {
        journal.write("plan", id, plan);
      }
    } finally {
      lock.release();
    }
  };
  const execute = async (id: string) => {
    const lock = tryAcquireDirectoryLock(journal.root, `batch-${id}`);
    if (!lock) {
      return;
    }
    try {
      const batch = requiredBatch(id);
      if (batch.state === "completed" || batch.state === "completed_with_issues") {
        return;
      }
      const plan = requiredPlan(batch.plan_id);
      batch.state = "running";
      journal.write("batch", id, batch);
      for (const item of batch.items) {
        if (terminal(item)) {
          continue;
        }
        if (item.state === "activating") {
          markConnectorLifecycleRecoveryRequired(deps.dataDir, item.connector_id);
          item.state = "recovery_required";
          item.error = {
            code: "recovery_required",
            message: "Publication was interrupted; reconcile registration and activation before dispatch.",
          };
          journal.write("batch", id, batch);
          continue;
        }
        let publicationStarted = false;
        try {
          const prepared = plan.prepared[item.connector_id];
          if (!prepared) {
            throw failure(409, "plan_changed", "Verified plan artifact is missing.");
          }
          item.state = "verified";
          journal.write("batch", id, batch);
          const deadline = now() + (deps.runBoundaryTimeoutMs ?? 30_000);
          let result: ConnectorInstallRecord | null = null;
          while (!result) {
            result = await withConnectorLifecycleLock(deps.dataDir, item.connector_id, async () => {
              assertConnectorLifecycleAvailable(deps.dataDir, item.connector_id);
              const installed = (await deps.installed()).find((record) => record.connectorId === item.connector_id);
              if (
                !installed ||
                installed.digest !== item.installed.digest ||
                installed.version !== item.installed.version ||
                (await deps.selectedLocalIds()).includes(item.connector_id)
              ) {
                throw failure(409, "plan_changed", "Installed connector changed before activation.");
              }
              if (await deps.hasActiveRuns(item.connector_id)) {
                return null;
              }
              item.state = "activating";
              journal.write("batch", id, batch);
              publicationStarted = true;
              return await deps.activate(prepared);
            });
            if (!result) {
              item.state = "waiting_for_run_boundary";
              journal.write("batch", id, batch);
              if (now() >= deadline) {
                item.state = "deferred";
                item.retry_eligible = true;
                break;
              }
              await pause(Math.min(100, Math.max(1, deadline - now())));
            }
          }
          if (result) {
            if (result.digest !== item.target.digest || result.version !== item.target.version) {
              throw failure(500, "recovery_required", "Activated tuple differs from the approved target.");
            }
            deps.completePublication?.(item.connector_id);
            item.state = "succeeded";
            deps.afterActivate?.(result);
            try {
              deps.onChanged?.();
              implementationChanged();
            } catch (error) {
              console.error(`[connector-updates] implementation notification: ${message(error)}`);
            }
          }
        } catch (error) {
          const code = (error as { code?: string }).code ?? "update_failed";
          if (code === "connector_install_busy") {
            item.state = "deferred";
          } else if ((publicationStarted && code !== "verification_failed") || code === "recovery_required") {
            item.state = "recovery_required";
          } else {
            item.state = "failed";
          }
          if (item.state === "recovery_required") {
            markConnectorLifecycleRecoveryRequired(deps.dataDir, item.connector_id);
          }
          item.error = {
            code: item.state === "recovery_required" ? "recovery_required" : code,
            message: message(error),
          };
          item.retry_eligible = code === "connector_install_busy";
        }
        journal.write("batch", id, batch);
      }
      batch.state = batch.items.every((item) => item.state === "succeeded") ? "completed" : "completed_with_issues";
      batch.completed_at = new Date(now()).toISOString();
      journal.write("batch", id, batch);
    } finally {
      lock.release();
    }
  };
  const createPlan = () => {
    const id = randomUUID();
    const plan: StoredPlan = {
      catalog_revision: null,
      created_at: new Date(now()).toISOString(),
      expires_at: new Date(now() + 15 * 60_000).toISOString(),
      installed_revision: null,
      items: [],
      manual_count: 0,
      plan_id: id,
      prepared: {},
      review_count: 0,
      state: "checking",
    };
    journal.write("plan", id, plan);
    background(`plan-${id}`, () => build(id));
    return { plan_id: id, status_url: planUrl(id) };
  };
  const getPlan = (id: string) => {
    const plan = requiredPlan(id);
    if (plan.state === "checking") {
      background(`plan-${id}`, () => build(id));
    }
    return publicPlan(plan);
  };
  const assertCurrentPlan = async (plan: StoredPlan) => {
    if (plan.state !== "ready") {
      throw failure(409, "plan_not_ready", "Update plan must be ready before applying it.");
    }
    const captured = await snapshot();
    if (
      now() >= Date.parse(plan.expires_at) ||
      captured.catalogRevision !== plan.catalog_revision ||
      captured.installedRevision !== plan.installed_revision
    ) {
      throw failure(409, "plan_changed", "Catalog, installed connector, or plan expiry changed; create a new plan.");
    }
  };
  const acquireRequestsLock = async () => {
    const deadline = Date.now() + 10_000;
    let lock = tryAcquireDirectoryLock(journal.root, "requests");
    while (!lock) {
      if (Date.now() >= deadline) {
        throw failure(
          409,
          "request_busy",
          "Another update request is still being validated; retry with the same idempotency key."
        );
      }
      await pause(10);
      lock = tryAcquireDirectoryLock(journal.root, "requests");
    }
    return lock;
  };
  const createBatch = async (input: {
    plan_id: string;
    idempotency_key: string;
    selected_connector_ids?: string[];
    consent_token?: string;
  }) => {
    if (!input.idempotency_key.trim() || input.idempotency_key.length > 200) {
      throw failure(400, "invalid_request", "idempotency_key must contain 1 to 200 characters.");
    }
    const lock = await acquireRequestsLock();
    try {
      const plan = requiredPlan(input.plan_id);
      const selection = input.selected_connector_ids
        ? [...new Set(input.selected_connector_ids)].sort()
        : plan.items
            .filter((item) => item.manual_eligible)
            .map((item) => item.connector_id)
            .sort();
      for (const id of journal.ids("batch")) {
        const existing = requiredBatch(id);
        if (existing.idempotency_key !== input.idempotency_key) {
          continue;
        }
        if (
          existing.plan_id !== input.plan_id ||
          canonical(existing.items.map((item) => item.connector_id).sort()) !== canonical(selection)
        ) {
          throw failure(409, "idempotency_conflict", "Idempotency key already identifies another request.");
        }
        if (
          existing.items.some(
            (item) => plan.items.find((candidate) => candidate.connector_id === item.connector_id)?.review_required
          )
        ) {
          const consent = input.consent_token && journal.read<UpdateConsent>("consent", input.consent_token);
          if (!consent || consent.consumed_batch_id !== id) {
            throw failure(409, "consent_used", "Review consent was already consumed or does not identify this batch.");
          }
        }
        return { batch_id: id, status_url: batchUrl(id) };
      }
      const consent = input.consent_token && journal.read<UpdateConsent>("consent", input.consent_token);
      if (input.consent_token && (!consent || consent.consumed_batch_id)) {
        throw failure(409, "consent_used", "Review consent is unknown or was already consumed.");
      }
      await assertCurrentPlan(plan);
      if (
        consent &&
        (selection.length !== 1 || consent.plan_id !== plan.plan_id || consent.connector_id !== selection[0])
      ) {
        throw failure(409, "consent_mismatch", "Review consent is bound to one plan item.");
      }
      const items = selection.map((connectorId) => {
        const item = plan.items.find((candidate) => candidate.connector_id === connectorId);
        const reviewed =
          item?.review_required &&
          consent &&
          item.target.digest === consent.target_digest &&
          fingerprint(item) === consent.item_fingerprint &&
          plan.prepared[connectorId];
        if (!(item && (item.manual_eligible || reviewed))) {
          throw failure(409, "review_required", "Selected connector requires review or failed verification.");
        }
        return {
          connector_id: item.connector_id,
          ...(item.display_name ? { display_name: item.display_name } : {}),
          installed: item.installed,
          retry_eligible: false,
          state: "queued" as const,
          target: item.target,
        };
      });
      if (consent && !plan.items.some((item) => item.connector_id === selection[0] && item.review_required)) {
        throw failure(409, "consent_mismatch", "Review consent cannot be used for an ordinary update.");
      }
      const id = randomUUID();
      const batch: ConnectorUpdateBatch = {
        batch_id: id,
        created_at: new Date(now()).toISOString(),
        idempotency_key: input.idempotency_key,
        items,
        plan_id: plan.plan_id,
        state: "queued",
      };
      if (consent && input.consent_token) {
        consent.consumed_batch_id = id;
        journal.write("consent", input.consent_token, consent);
      }
      journal.write("batch", id, batch);
      background(`batch-${id}`, () => execute(id));
      return { batch_id: id, status_url: batchUrl(id) };
    } finally {
      lock.release();
    }
  };
  const getBatch = (id: string) => {
    const batch = requiredBatch(id);
    if (batch.state === "queued" || batch.state === "running") {
      background(`batch-${id}`, () => execute(id));
    }
    return batch;
  };
  const wait = async (key: string) => {
    await running.get(key);
  };
  // Polling and startup both resume pre-publication work; uncertain publication is never retried.
  for (const id of journal.ids("plan")) {
    if (requiredPlan(id).state === "checking") {
      background(`plan-${id}`, () => build(id));
    }
  }
  for (const id of journal.ids("batch")) {
    if (["queued", "running"].includes(requiredBatch(id).state)) {
      background(`batch-${id}`, () => execute(id));
    }
  }
  return {
    createBatch,
    createPlan,
    getBatch,
    getPlan,
    async issueConsent(input: { plan_id: string; connector_id: string; target_digest: string }) {
      const plan = requiredPlan(input.plan_id);
      await assertCurrentPlan(plan);
      const item = plan.items.find((candidate) => candidate.connector_id === input.connector_id);
      if (
        !(item?.review_required && plan.prepared[input.connector_id]) ||
        item.reasons.includes("verification_failed") ||
        item.target.digest !== input.target_digest
      ) {
        throw failure(409, "review_required", "Reviewed target is unavailable or does not match the exact digest.");
      }
      const consent_token = randomUUID();
      journal.write("consent", consent_token, {
        connector_id: item.connector_id,
        consumed_batch_id: null,
        item_fingerprint: fingerprint(item),
        plan_id: plan.plan_id,
        target_digest: item.target.digest,
      } satisfies UpdateConsent);
      return { consent_token };
    },
    onImplementationChanged(callback: () => void) {
      implementationChanged = callback;
    },
    async settled() {
      await Promise.all([...running.values()]);
    },
    async updateOne(connectorId: string) {
      // A registration carried over from the pre-OCI bundle has a manifest but
      // no verified install record, so a plan has no installed tuple to diff.
      // Keep publishing the catalog target for it through the direct path.
      if (!(await deps.installed()).some((record) => record.connectorId === connectorId)) {
        return await deps.directUpdate(connectorId);
      }
      const created = createPlan();
      await wait(`plan-${created.plan_id}`);
      const plan = getPlan(created.plan_id);
      const item = plan.items.find((candidate) => candidate.connector_id === connectorId);
      if (!item?.manual_eligible) {
        throw failure(409, "review_required", "No eligible manual target; inspect an update plan for review details.");
      }
      const batch = await createBatch({
        idempotency_key: randomUUID(),
        plan_id: created.plan_id,
        selected_connector_ids: [connectorId],
      });
      await wait(`batch-${batch.batch_id}`);
      const [result] = getBatch(batch.batch_id).items;
      if (!result) {
        throw failure(500, "batch_missing_result", "The connector update batch has no result.");
      }
      if (result.state !== "succeeded") {
        throw failure(
          409,
          result.error?.code ?? result.state,
          result.error?.message ?? "Update deferred until the active run finishes."
        );
      }
      const installed = (await deps.installed()).find((record) => record.connectorId === connectorId);
      if (!installed || installed.digest !== item.target.digest) {
        throw failure(409, "plan_changed", "Installed connector changed after update.");
      }
      return installed;
    },
  };
}
export type ConnectorUpdateService = ReturnType<typeof createConnectorUpdateService>;
