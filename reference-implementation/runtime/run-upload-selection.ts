// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/** Detached START.scope and manifest facts needed to admit a RECORD. */
// biome-ignore lint/style/useConsistentTypeDefinitions: The private API contract exports this as a type.
export type RunUploadSelection = {
  readonly streams: readonly {
    readonly name: string;
    readonly resources: readonly string[] | null;
    readonly fields: readonly string[] | null;
    readonly requiredFields: readonly string[];
    readonly resourceField: string | null;
    readonly consentTimeField: string | null;
    readonly timeRange: { readonly since: string | null; readonly until: string | null } | null;
  }[];
  readonly version: 1;
};

interface ScopeSource {
  readonly streams: readonly {
    readonly name: string;
    readonly resources?: readonly string[] | null;
    readonly fields?: readonly string[] | null;
    readonly time_range?: { readonly since?: string | null; readonly until?: string | null } | null;
  }[];
}

type ManifestSource =
  | {
      readonly streams?:
        | readonly {
            readonly name: string;
            readonly schema?: { readonly required?: readonly string[] } | null;
            readonly selection?: { readonly resource_field?: string } | null;
            readonly consent_time_field?: string | null;
          }[]
        | null;
    }
  | null
  | undefined;

/**
 * Capture the normalized START scope and pinned manifest once. Maps preserve
 * runtime admission's last-value behavior for duplicate stream names.
 */
export function snapshotRunUploadSelection(scope: ScopeSource, manifest: ManifestSource): RunUploadSelection {
  const scopeByStream = new Map(scope.streams.map((stream) => [stream.name, stream]));
  const manifestByStream = new Map((manifest?.streams || []).map((stream) => [stream.name, stream]));
  return {
    streams: Array.from(scopeByStream, ([name, streamScope]) => {
      const manifestStream = manifestByStream.get(name);
      const timeRange = streamScope.time_range;
      const resourceField = manifestStream?.selection?.resource_field;
      return {
        consentTimeField: manifestStream?.consent_time_field || null,
        fields: Array.isArray(streamScope.fields) ? [...streamScope.fields] : null,
        name,
        requiredFields: [...(manifestStream?.schema?.required || [])],
        resourceField: typeof resourceField === "string" && resourceField.length > 0 ? resourceField : null,
        resources: Array.isArray(streamScope.resources) ? [...streamScope.resources] : null,
        timeRange: timeRange ? { since: timeRange.since ?? null, until: timeRange.until ?? null } : null,
      };
    }),
    version: 1,
  };
}

/** Parse the private persisted representation into a detached version 1 value. */
export function parseRunUploadSelection(input: unknown): RunUploadSelection {
  if (
    !(isObject(input) && hasOnlyKeys(input, ["version", "streams"])) ||
    input.version !== 1 ||
    !Array.isArray(input.streams)
  ) {
    throw invalidSelection();
  }
  const names = new Set<string>();
  const streams = input.streams.map((rawStream) => {
    if (
      !(
        isObject(rawStream) &&
        hasOnlyKeys(rawStream, [
          "name",
          "resources",
          "fields",
          "requiredFields",
          "resourceField",
          "consentTimeField",
          "timeRange",
        ])
      ) ||
      typeof rawStream.name !== "string" ||
      !rawStream.name ||
      names.has(rawStream.name) ||
      !isNullableStringArray(rawStream.resources) ||
      !isNullableStringArray(rawStream.fields) ||
      !isStringArray(rawStream.requiredFields) ||
      !isNullableString(rawStream.resourceField) ||
      !isNullableString(rawStream.consentTimeField) ||
      !isTimeRange(rawStream.timeRange)
    ) {
      throw invalidSelection();
    }
    names.add(rawStream.name);
    return {
      consentTimeField: rawStream.consentTimeField,
      fields: rawStream.fields === null ? null : [...rawStream.fields],
      name: rawStream.name,
      requiredFields: [...rawStream.requiredFields],
      resourceField: rawStream.resourceField,
      resources: rawStream.resources === null ? null : [...rawStream.resources],
      timeRange: rawStream.timeRange === null ? null : { ...rawStream.timeRange },
    };
  });
  return { streams, version: 1 };
}

/** Enforce the detached scope facts with the runtime's RECORD rejection text. */
export function assertRecordWithinRunUploadSelection(
  selection: RunUploadSelection,
  record: { readonly stream: string; readonly key: unknown; readonly data: unknown }
): void {
  const stream = selection.streams.find((candidate) => candidate.name === record.stream);
  if (!stream) {
    throw new Error(`Connector emitted RECORD for undeclared stream: ${record.stream}`);
  }
  if (!recordMatchesResources(stream.resources, record.key, record.data, stream.resourceField)) {
    throw new Error(`Connector emitted RECORD outside declared resources for stream: ${record.stream}`);
  }
  if (stream.fields && record.data && typeof record.data === "object") {
    const allowedFields = new Set([...stream.fields, ...stream.requiredFields]);
    const extraFields = Object.keys(record.data).filter((field) => !allowedFields.has(field));
    if (extraFields.length) {
      throw new Error(
        `Connector emitted RECORD with fields outside START.scope for stream '${record.stream}': ${extraFields.join(", ")}`
      );
    }
  }
  if (
    stream.timeRange &&
    record.data &&
    typeof record.data === "object" &&
    stream.consentTimeField &&
    !passesTimeRange(record.data, stream.timeRange, stream.consentTimeField)
  ) {
    throw new Error(`Connector emitted RECORD outside declared time_range for stream: ${record.stream}`);
  }
}

function recordMatchesResources(
  resources: readonly string[] | null,
  key: unknown,
  data: unknown,
  resourceField: string | null
): boolean {
  if (!resources?.length) {
    return true;
  }
  const allowed = new Set(resources.map(String));
  if (allowed.has(encodeScopeResourceKey(key))) {
    return true;
  }
  if (!(resourceField && data && typeof data === "object" && !Array.isArray(data))) {
    return false;
  }
  const value = (data as Record<string, unknown>)[resourceField];
  if (value === null || value === undefined) {
    return false;
  }
  const resourceKey = Array.isArray(value) ? JSON.stringify(value.map(String)) : String(value);
  return allowed.has(resourceKey);
}

function encodeScopeResourceKey(key: unknown): string {
  return Array.isArray(key) ? JSON.stringify(key) : String(key);
}

function passesTimeRange(
  data: unknown,
  timeRange: { readonly since: string | null; readonly until: string | null },
  consentTimeField: string
): boolean {
  const value = (data as Record<string, unknown> | null | undefined)?.[consentTimeField];
  if (!value) {
    return false;
  }
  const timestamp = new Date(value as string).getTime();
  if (Number.isNaN(timestamp)) {
    return false;
  }
  if (timeRange.since && timestamp < new Date(timeRange.since).getTime()) {
    return false;
  }
  if (timeRange.until && timestamp >= new Date(timeRange.until).getTime()) {
    return false;
  }
  return true;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const allowed = new Set(keys);
  return Object.keys(value).every((key) => allowed.has(key));
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isNullableStringArray(value: unknown): value is string[] | null {
  return value === null || isStringArray(value);
}

function isTimeRange(value: unknown): value is { since: string | null; until: string | null } | null {
  return (
    value === null ||
    (isObject(value) &&
      hasOnlyKeys(value, ["since", "until"]) &&
      Object.keys(value).length === 2 &&
      isNullableString(value.since) &&
      isNullableString(value.until))
  );
}

function invalidSelection(): Error {
  return new Error("Invalid run upload selection");
}
