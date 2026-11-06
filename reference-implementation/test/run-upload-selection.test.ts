// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import {
  assertRecordWithinRunUploadSelection,
  parseRunUploadSelection,
  snapshotRunUploadSelection,
} from "../runtime/run-upload-selection.ts";

type Scope = Parameters<typeof snapshotRunUploadSelection>[0];
type Manifest = NonNullable<Parameters<typeof snapshotRunUploadSelection>[1]>;
const INVALID_SELECTION = /Invalid run upload selection/;
interface RecordInput {
  readonly data: unknown;
  readonly key: unknown;
  readonly stream: string;
}

// Bounded reference oracle: these predicates preserve the pre-extraction
// RECORD scope rules from runtime/index.ts. The production implementation is
// the detached selector above, which every case below compares against it.
function legacyRecordAdmission(scope: Scope, manifest: Manifest, record: RecordInput): void {
  const scopeByStream = new Map(scope.streams.map((stream) => [stream.name, stream]));
  const manifestByStream = new Map((manifest.streams || []).map((stream) => [stream.name, stream]));
  const streamScope = scopeByStream.get(record.stream);
  if (!streamScope) {
    throw new Error(`Connector emitted RECORD for undeclared stream: ${record.stream}`);
  }
  const manifestStream = manifestByStream.get(record.stream) || null;
  if (!legacyRecordMatchesScopeResource(streamScope.resources, record.key, record.data, manifestStream)) {
    throw new Error(`Connector emitted RECORD outside declared resources for stream: ${record.stream}`);
  }
  if (Array.isArray(streamScope.fields) && record.data && typeof record.data === "object") {
    const requiredFields = new Set(manifestStream?.schema?.required || []);
    const allowedFields = new Set([...streamScope.fields, ...requiredFields]);
    const extraFields = Object.keys(record.data).filter((field) => !allowedFields.has(field));
    if (extraFields.length) {
      throw new Error(
        `Connector emitted RECORD with fields outside START.scope for stream '${record.stream}': ${extraFields.join(", ")}`
      );
    }
  }
  if (streamScope.time_range && record.data && typeof record.data === "object") {
    const consentTimeField = manifestStream?.consent_time_field || null;
    if (consentTimeField && !legacyPassesTimeRange(record.data, streamScope.time_range, consentTimeField)) {
      throw new Error(`Connector emitted RECORD outside declared time_range for stream: ${record.stream}`);
    }
  }
}

function legacyRecordMatchesScopeResource(
  resources: readonly string[] | null | undefined,
  key: unknown,
  data: unknown,
  manifestStream: Manifest["streams"] extends readonly (infer T)[] | null | undefined ? T | null : never
): boolean {
  if (!(Array.isArray(resources) && resources.length)) {
    return true;
  }
  const allowed = new Set(resources.map(String));
  const encodedKey = Array.isArray(key) ? JSON.stringify(key) : String(key);
  if (allowed.has(encodedKey)) {
    return true;
  }
  const selection = manifestStream?.selection;
  const field =
    selection && typeof selection === "object" && !Array.isArray(selection) ? selection.resource_field : null;
  const resourceField = typeof field === "string" && field.length > 0 ? field : null;
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

function legacyPassesTimeRange(
  data: unknown,
  timeRange: { readonly since?: string | null; readonly until?: string | null } | null | undefined,
  consentTimeField: string | null | undefined
): boolean {
  if (!(timeRange && consentTimeField)) {
    return true;
  }
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

function outcome(action: () => void): string | null {
  try {
    action();
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

function compareAdmission(name: string, scope: Scope, manifest: Manifest, record: RecordInput): void {
  const expected = outcome(() => legacyRecordAdmission(scope, manifest, record));
  const selection = snapshotRunUploadSelection(scope, manifest);
  const actual = outcome(() => assertRecordWithinRunUploadSelection(selection, record));
  assert.equal(actual, expected, name);
}

test("RECORD admission matches the pre-extraction scope predicates across a discriminator matrix", () => {
  const unrestrictedScope = { streams: [{ name: "items" }] } satisfies Scope;
  const unrestrictedManifest = { streams: [{ name: "items" }] } satisfies Manifest;
  const matrix: { name: string; scope: Scope; manifest: Manifest; record: RecordInput }[] = [
    {
      manifest: unrestrictedManifest,
      name: "unrestricted missing fields",
      record: { data: { x: 1 }, key: "k", stream: "items" },
      scope: unrestrictedScope,
    },
    {
      manifest: unrestrictedManifest,
      name: "undeclared stream keeps handler rejection",
      record: { data: {}, key: "k", stream: "other" },
      scope: unrestrictedScope,
    },
    {
      manifest: unrestrictedManifest,
      name: "empty resources are unconstrained",
      record: { data: {}, key: "other", stream: "items" },
      scope: { streams: [{ name: "items", resources: [] }] },
    },
    {
      manifest: unrestrictedManifest,
      name: "primary key resource acceptance",
      record: { data: {}, key: "primary", stream: "items" },
      scope: { streams: [{ name: "items", resources: ["primary"] }] },
    },
    {
      manifest: { streams: [{ name: "items", selection: { resource_field: "account_id" } }] },
      name: "resource outside both primary key and resource_field rejects",
      record: { data: { account_id: "forbidden" }, key: "forbidden", stream: "items" },
      scope: { streams: [{ name: "items", resources: ["allowed"] }] },
    },
    {
      manifest: { streams: [{ name: "items", selection: { resource_field: "account_id" } }] },
      name: "manifest resource_field accepts when primary key differs",
      record: { data: { account_id: "external" }, key: "primary", stream: "items" },
      scope: { streams: [{ name: "items", resources: ["external"] }] },
    },
    {
      manifest: unrestrictedManifest,
      name: "compound primary key uses JSON encoding",
      record: { data: {}, key: ["a", "b"], stream: "items" },
      scope: { streams: [{ name: "items", resources: ['["a","b"]'] }] },
    },
    {
      manifest: { streams: [{ name: "items", selection: { resource_field: "account_ids" } }] },
      name: "array resource_field maps each value through String",
      record: { data: { account_ids: [1, 2] }, key: "other", stream: "items" },
      scope: { streams: [{ name: "items", resources: ['["1","2"]'] }] },
    },
    {
      manifest: { streams: [{ name: "items", schema: { required: ["id"] } }] },
      name: "field list preserves extra field order and required fields",
      record: { data: { a: 2, id: "1", title: "ok", z: 1 }, key: "k", stream: "items" },
      scope: { streams: [{ fields: ["title"], name: "items" }] },
    },
    {
      manifest: { streams: [{ name: "items", schema: { required: ["id"] } }] },
      name: "empty field list allows only required fields",
      record: { data: { extra: true, id: "1" }, key: "k", stream: "items" },
      scope: { streams: [{ fields: [], name: "items" }] },
    },
    {
      manifest: { streams: [{ name: "items", schema: { required: ["id"] } }] },
      name: "empty field list still allows schema-required fields",
      record: { data: { id: "1" }, key: "k", stream: "items" },
      scope: { streams: [{ fields: [], name: "items" }] },
    },
    {
      manifest: { streams: [{ consent_time_field: "created_at", name: "items" }] },
      name: "since is inclusive",
      record: { data: { created_at: "2026-01-01T00:00:00Z" }, key: "k", stream: "items" },
      scope: { streams: [{ name: "items", time_range: { since: "2026-01-01T00:00:00Z" } }] },
    },
    {
      manifest: { streams: [{ consent_time_field: "created_at", name: "items" }] },
      name: "until is exclusive",
      record: { data: { created_at: "2026-02-01T00:00:00Z" }, key: "k", stream: "items" },
      scope: { streams: [{ name: "items", time_range: { until: "2026-02-01T00:00:00Z" } }] },
    },
    {
      manifest: { streams: [{ consent_time_field: "created_at", name: "items" }] },
      name: "missing consent time rejects",
      record: { data: { created_at: "" }, key: "k", stream: "items" },
      scope: { streams: [{ name: "items", time_range: { since: "2026-01-01T00:00:00Z" } }] },
    },
    {
      manifest: { streams: [{ consent_time_field: "created_at", name: "items" }] },
      name: "invalid time bound keeps legacy JavaScript Date behavior",
      record: { data: { created_at: "2026-01-15T00:00:00Z" }, key: "k", stream: "items" },
      scope: { streams: [{ name: "items", time_range: { since: "not-a-date" } }] },
    },
    {
      manifest: {
        streams: [
          { name: "items", selection: { resource_field: "old_id" } },
          { name: "items", selection: { resource_field: "new_id" } },
        ],
      },
      name: "duplicate stream names use last scope and manifest entries",
      record: { data: { new_id: "new" }, key: "no", stream: "items" },
      scope: {
        streams: [
          { name: "items", resources: ["old"] },
          { name: "items", resources: ["new"] },
        ],
      },
    },
  ];
  for (const item of matrix) {
    compareAdmission(item.name, item.scope, item.manifest, item.record);
  }
});

test("resource_field acceptance remains an OR with primary-key acceptance", () => {
  const scope = { streams: [{ name: "items", resources: ["external"] }] };
  const manifest = { streams: [{ name: "items", selection: { resource_field: "account_id" } }] };
  const selection = snapshotRunUploadSelection(scope, manifest);
  assert.doesNotThrow(() =>
    assertRecordWithinRunUploadSelection(selection, { data: {}, key: "external", stream: "items" })
  );
  assert.doesNotThrow(() =>
    assertRecordWithinRunUploadSelection(selection, {
      data: { account_id: "external" },
      key: "different",
      stream: "items",
    })
  );
});

test("snapshot detaches scope and manifest values from later mutation", () => {
  const resources = ["r1"];
  const fields = ["name"];
  const required = ["id"];
  const scope = { streams: [{ fields, name: "items", resources, time_range: { since: "2026-01-01T00:00:00Z" } }] };
  const manifest = {
    streams: [
      {
        consent_time_field: "created_at",
        name: "items",
        schema: { required },
        selection: { resource_field: "account_id" },
      },
    ],
  };
  const selection = snapshotRunUploadSelection(scope, manifest);
  resources.push("later");
  fields.push("later");
  required.push("later");
  const firstScope = scope.streams.at(0);
  assert.ok(firstScope);
  const timeRange = firstScope.time_range;
  assert.ok(timeRange);
  timeRange.since = "2027-01-01T00:00:00Z";
  const firstManifestStream = manifest.streams.at(0);
  assert.ok(firstManifestStream);
  const selectionDeclaration = firstManifestStream.selection;
  assert.ok(selectionDeclaration);
  selectionDeclaration.resource_field = "later";
  assert.deepEqual(selection.streams[0], {
    consentTimeField: "created_at",
    fields: ["name"],
    name: "items",
    requiredFields: ["id"],
    resourceField: "account_id",
    resources: ["r1"],
    timeRange: { since: "2026-01-01T00:00:00Z", until: null },
  });
});

test("private selection parser detaches valid values and rejects malformed or duplicate entries", () => {
  const input = {
    streams: [
      {
        consentTimeField: "created_at",
        fields: null,
        name: "items",
        requiredFields: ["id"],
        resourceField: null,
        resources: ["r1"],
        timeRange: { since: null, until: "2026-02-01T00:00:00Z" },
      },
    ],
    version: 1,
  };
  const parsed = parseRunUploadSelection(input);
  const inputStream = input.streams.at(0);
  assert.ok(inputStream);
  inputStream.resources.push("later");
  assert.deepEqual(parsed.streams[0]?.resources, ["r1"]);
  for (const malformed of [
    { ...input, version: 2 },
    { ...input, unexpected: true },
    { streams: [{ ...input.streams[0], unexpected: true }], version: 1 },
    { streams: [input.streams[0], input.streams[0]], version: 1 },
    { streams: [{ ...input.streams[0], resources: ["ok", 1] }], version: 1 },
    { streams: [{ ...input.streams[0], timeRange: { since: null } }], version: 1 },
  ]) {
    assert.throws(() => parseRunUploadSelection(malformed), INVALID_SELECTION);
  }
});
