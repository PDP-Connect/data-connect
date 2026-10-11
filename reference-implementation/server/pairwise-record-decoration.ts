// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { passesTimeConstraint } from "./record-filters.ts";

type JsonObject = Record<string, unknown>;

export interface PairwiseDecorationStreamGrant {
  fields?: readonly string[];
  instance_ids?: readonly string[];
  name: string;
  resources?: readonly string[];
  time_constraint?: unknown;
}

export interface PairwiseRecordDecorationOptions {
  blobBaseUrl: string;
  blobConnectorId?: string;
  // Only frozen declaration facts may prove access to all target key fields.
  // Missing retained facts cause client references to be redacted.
  getTargetPrimaryKeyFields?: (stream: string) => Promise<readonly string[] | null>;
  // The caller must scope this lookup to the referencing record's internal
  // instance and return unprojected data, so a hidden temporal field is checked.
  getTargetRecord: (stream: string, id: string) => Promise<JsonObject | null>;
  grant: {
    source?: { id?: string };
    streams?: readonly PairwiseDecorationStreamGrant[];
  } | null;
  instanceId: string;
  sourceId: string;
}

function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function canonicalReferenceId(value: unknown): string | null {
  if (typeof value === "string" && value.length > 0) {
    return value;
  }
  if (Array.isArray(value) && value.length > 0 && value.every((part) => typeof part === "string")) {
    return JSON.stringify(value);
  }
  return null;
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Keep the ordered target authorization checks together at this disclosure boundary.
async function decorateReference(ref: JsonObject, options: PairwiseRecordDecorationOptions): Promise<JsonObject> {
  const { source_id: sourceId, stream } = ref;
  const redacted = { redacted: true, source_id: sourceId, stream };
  if (typeof stream !== "string" || sourceId !== options.sourceId) {
    return redacted;
  }
  const id = canonicalReferenceId(ref.record_id);
  if (id === null) {
    return redacted;
  }
  const { grant } = options;
  const streamGrant = grant?.streams?.find((entry) => entry.name === stream);
  if (grant) {
    if (
      grant.source?.id !== options.sourceId ||
      !streamGrant?.instance_ids?.includes(options.instanceId) ||
      (streamGrant.resources !== undefined && !streamGrant.resources.includes(id))
    ) {
      return redacted;
    }
    const keyFields = await options.getTargetPrimaryKeyFields?.(stream);
    if (!(keyFields?.length && keyFields.every((field) => field.length > 0 && streamGrant.fields?.includes(field)))) {
      return redacted;
    }
  }
  const target = await options.getTargetRecord(stream, id);
  if (
    !target ||
    target.deleted === true ||
    (target.id !== undefined && target.id !== id) ||
    (target.stream !== undefined && target.stream !== stream) ||
    (target.instance_id !== undefined && target.instance_id !== options.instanceId)
  ) {
    return redacted;
  }
  if (grant) {
    try {
      if (!passesTimeConstraint(isObject(target.data) ? target.data : null, streamGrant?.time_constraint)) {
        return redacted;
      }
    } catch {
      // An unsupported frozen constraint must not become an unrestricted read.
      return redacted;
    }
  }
  return {
    instance_id: options.instanceId,
    record_id: structuredClone(ref.record_id),
    source_id: sourceId,
    stream,
  };
}

async function decorateValue(value: unknown, options: PairwiseRecordDecorationOptions): Promise<unknown> {
  if (Array.isArray(value)) {
    return Promise.all(value.map((entry) => decorateValue(entry, options)));
  }
  if (!isObject(value)) {
    return value;
  }
  if (
    typeof value.source_id === "string" &&
    typeof value.stream === "string" &&
    (Object.hasOwn(value, "record_id") || value.redacted === true)
  ) {
    return decorateReference(value, options);
  }
  const entries = await Promise.all(
    Object.entries(value).map(async ([key, entry]) => [key, await decorateValue(entry, options)])
  );
  const decorated: JsonObject = Object.fromEntries(entries);
  if (typeof value.blob_id === "string" && value.blob_id.length > 0) {
    const baseUrl = options.blobBaseUrl.endsWith("/") ? options.blobBaseUrl.slice(0, -1) : options.blobBaseUrl;
    const sourceSelector =
      options.blobConnectorId === undefined ? "" : `&connector_id=${encodeURIComponent(options.blobConnectorId)}`;
    decorated.fetch_url = `${baseUrl}/${encodeURIComponent(value.blob_id)}?instance_id=${encodeURIComponent(options.instanceId)}${sourceSelector}`;
  }
  return decorated;
}

/** Decorate projected response data without modifying producer or storage values. */
export async function decoratePairwiseRecord<T extends JsonObject>(
  record: T,
  options: PairwiseRecordDecorationOptions
): Promise<T & { instance_id: string }> {
  return {
    ...record,
    ...(Object.hasOwn(record, "data") ? { data: await decorateValue(record.data, options) } : {}),
    instance_id: options.instanceId,
  };
}
