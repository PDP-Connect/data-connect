// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/** Owner update API values used by the Add source control. */
export interface ConnectorUpdateVersion {
  readonly digest: string;
  readonly version: string | null;
}

export interface ConnectorManifestDiff {
  readonly added_fields: readonly string[];
  readonly changed_fields: readonly string[];
  readonly compatibility: string;
  readonly removed_fields: readonly string[];
}

export interface ConnectorUpdatePlanItem {
  readonly connector_id: string;
  readonly display_name?: string;
  readonly installed: ConnectorUpdateVersion;
  readonly manifest_diff?: ConnectorManifestDiff;
  readonly manual_eligible: boolean;
  readonly reasons: readonly string[];
  readonly review_required: boolean;
  readonly target: ConnectorUpdateVersion;
}

export interface ConnectorUpdatePlan {
  readonly error?: string;
  readonly items: readonly ConnectorUpdatePlanItem[];
  readonly manual_count: number;
  readonly plan_id: string;
  readonly review_count: number;
  readonly state: "checking" | "ready" | "failed";
}

export interface ConnectorUpdateBatchItem {
  readonly connector_id: string;
  readonly display_name?: string;
  readonly error?: string;
  readonly installed: ConnectorUpdateVersion;
  readonly state: string;
  readonly target: ConnectorUpdateVersion;
}

export interface ConnectorUpdateBatch {
  readonly batch_id: string;
  readonly items: readonly ConnectorUpdateBatchItem[];
  readonly state: string;
}

function record(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${name} is missing from the connector update response.`);
  }
  return value as Record<string, unknown>;
}

function string(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${name} is missing from the connector update response.`);
  }
  return value;
}

function version(value: unknown, name: string): ConnectorUpdateVersion {
  const fields = record(value, name);
  return {
    digest: string(fields.digest, `${name}.digest`),
    version: typeof fields.version === "string" ? fields.version : null,
  };
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

function manifestDiff(value: unknown): ConnectorManifestDiff | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const fields = value as Record<string, unknown>;
  return {
    added_fields: strings(fields.added_fields),
    changed_fields: strings(fields.changed_fields),
    compatibility: typeof fields.compatibility === "string" ? fields.compatibility : "unknown",
    removed_fields: strings(fields.removed_fields),
  };
}

function data(payload: unknown): Record<string, unknown> {
  return record(record(payload, "response").data, "response.data");
}

export function parseConnectorUpdateJobId(payload: unknown, key: "plan_id" | "batch_id"): string {
  return string(data(payload)[key], key);
}

export function parseConnectorUpdateConsentToken(payload: unknown): string {
  // The route may return the token bare or in the usual `data` envelope.
  const body = record(payload, "response");
  return string(body.consent_token ?? record(body.data, "response.data").consent_token, "consent_token");
}

export function parseConnectorUpdatePlan(payload: unknown): ConnectorUpdatePlan {
  const body = data(payload);
  const state = string(body.state, "plan.state");
  if (state !== "checking" && state !== "ready" && state !== "failed") {
    throw new Error("The connector update plan has an unknown status.");
  }
  const rawItems = body.items;
  const items = Array.isArray(rawItems)
    ? rawItems.map((value: unknown) => {
        const item = record(value, "plan.item");
        return {
          connector_id: string(item.connector_id, "plan.item.connector_id"),
          display_name: optionalString(item.display_name),
          installed: version(item.installed, "plan.item.installed"),
          manifest_diff: manifestDiff(item.manifest_diff),
          manual_eligible: item.manual_eligible === true,
          reasons: Array.isArray(item.reasons)
            ? item.reasons.filter((reason): reason is string => typeof reason === "string")
            : [],
          review_required: item.review_required === true,
          target: version(item.target, "plan.item.target"),
        };
      })
    : [];
  const manualCount = body.manual_count;
  const reviewCount = body.review_count;
  return {
    error: typeof body.error === "string" ? body.error : undefined,
    items,
    manual_count: typeof manualCount === "number" ? manualCount : items.filter((item) => item.manual_eligible).length,
    review_count: typeof reviewCount === "number" ? reviewCount : items.filter((item) => item.review_required).length,
    plan_id: string(body.plan_id, "plan.plan_id"),
    state,
  };
}

export function parseConnectorUpdateBatch(payload: unknown): ConnectorUpdateBatch {
  const body = data(payload);
  if (!Array.isArray(body.items)) {
    throw new Error("The connector update batch has no item results.");
  }
  return {
    batch_id: string(body.batch_id, "batch.batch_id"),
    items: body.items.map((value: unknown) => {
      const item = record(value, "batch.item");
      const { error: rawError } = item;
      const errorRecord =
        rawError && typeof rawError === "object" && !Array.isArray(rawError)
          ? (rawError as Record<string, unknown>)
          : null;
      let error: string | undefined;
      if (typeof rawError === "string") {
        error = rawError;
      } else if (typeof errorRecord?.message === "string") {
        error = errorRecord.message;
      }
      return {
        connector_id: string(item.connector_id, "batch.item.connector_id"),
        display_name: optionalString(item.display_name),
        error,
        installed: version(item.installed, "batch.item.installed"),
        state: string(item.state, "batch.item.state"),
        target: version(item.target, "batch.item.target"),
      };
    }),
    state: string(body.state, "batch.state"),
  };
}
