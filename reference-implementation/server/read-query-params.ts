// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { invalidQueryError } from "./record-filters.ts";

// Canonical public read query-param allowlist. `connection_id` is the
// canonical public connection identifier; `connector_instance_id` is the
// deprecated wire alias accepted during the migration window defined by
// `openspec/changes/expose-connection-identity-on-public-read`. Both are
// optional filters today; when storage enumerates multiple connections per
// owner they will narrow the result set. `subject_id` is forwarded by some
// MCP / dashboard clients for diagnostic context and is allowlisted alongside
// `connector_id` for parity with `/v1/streams` and `/v1/schema`.
const RECORD_QUERY_KEYS = [
  "changes_since",
  "connection_id",
  "connector_id",
  "connector_instance_id",
  "count",
  "cursor",
  "expand",
  "expand_limit",
  "fields",
  "filter",
  "limit",
  "order",
  "sort",
  "subject_id",
  "view",
  "window",
] as const;

const AGGREGATE_QUERY_KEYS = [
  "connection_id",
  "connector_id",
  "connector_instance_id",
  "field",
  "filter",
  "granularity",
  "group_by",
  "group_by_time",
  "limit",
  "metric",
  "subject_id",
  "time_zone",
] as const;

// qs normalizes bracketed/repeated arrays and nested filters before this check.
// Field names, filter operators, sort and expansion values remain the existing
// parsers' responsibility. Search owns its vocabulary in each search operation.
const SOURCE_QUERY_KEYS = ["connection_id", "connector_id", "connector_instance_id", "subject_id"];
const READ_QUERY_KEYS = {
  aggregate: new Set(AGGREGATE_QUERY_KEYS),
  blob: new Set(SOURCE_QUERY_KEYS),
  connectors: new Set(SOURCE_QUERY_KEYS),
  fieldWindow: new Set([
    ...SOURCE_QUERY_KEYS,
    "field",
    "offset_chars",
    "limit_chars",
    "q",
    "before_chars",
    "after_chars",
  ]),
  record: new Set([...SOURCE_QUERY_KEYS, "fields", "expand", "expand_limit"]),
  records: new Set(RECORD_QUERY_KEYS),
  schema: new Set([...SOURCE_QUERY_KEYS, "view", "detail", "stream"]),
  stream: new Set(SOURCE_QUERY_KEYS),
  streams: new Set(SOURCE_QUERY_KEYS),
};

export function validateReadQueryKeys(
  endpoint: keyof typeof READ_QUERY_KEYS,
  query: Readonly<Record<string, unknown>>
): void {
  const vocabulary: ReadonlySet<string> = READ_QUERY_KEYS[endpoint];
  for (const key of Object.keys(query)) {
    if (vocabulary.has(key)) {
      continue;
    }
    const hint = endpoint === "records" && key === "q" ? "; use /v1/search for text search" : "";
    throw Object.assign(invalidQueryError(`Unsupported query parameter: ${key}${hint}`), { param: key });
  }
}
