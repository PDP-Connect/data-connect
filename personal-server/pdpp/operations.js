// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
/**
 * Transport-independent PDPP Core read operations.
 *
 * `manifest` is intentionally an input, not a local manifest registry. The
 * host must supply data it has already validated at connector-install time.
 * `repository` is the only data boundary and receives the grant constraints
 * alongside every query; it owns opaque cursor encoding and storage details.
 */

export const DEFAULT_LIMIT = 25;
export const MAX_LIMIT = 100;

export class CoreOperationError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = 'CoreOperationError';
    this.status = status;
    this.code = code;
  }
}

export function executeStreamsList({ subjectId, grant, manifest }, repository) {
  const allowed = new Set((grant.streams ?? []).map((stream) => stream.name));
  const declared = new Map(manifest.streams.map((stream) => [stream.name, stream]));
  return Promise.resolve(repository.listStreams({ subjectId, grant, manifest }))
    .then((streams) => streams
      .filter((stream) => allowed.has(stream.name) && declared.has(stream.name))
      .map((stream) => ({ ...stream, ...manifestStreamMetadata(declared.get(stream.name)) })));
}

function manifestStreamMetadata(stream) {
  const properties = stream.schema?.properties ?? {};
  const fields = Object.entries(properties).map(([name, schema]) => ({
    name,
    ...(schema?.type === undefined ? {} : { type: schema.type }),
    ...(schema?.format === undefined ? {} : { format: schema.format }),
  }));
  return {
    fields,
    primary_key: Array.isArray(stream.primary_key) ? stream.primary_key : [],
    timestamp_fields: [
      ...new Set([stream.consent_time_field, stream.cursor_field].filter((field) => typeof field === 'string')),
    ],
  };
}

export async function executeRecordsList(input, repository) {
  const context = resolveReadContext(input);
  if (input.query.changesSince !== null && Object.keys(input.query.filters).length > 0) {
    throw new CoreOperationError(400, 'invalid_request', 'filter cannot be used with changes_since');
  }
  const result = await repository.listRecords({
    subjectId: input.subjectId,
    stream: context.stream.name,
    grant: context.grant,
    cursor: input.query.cursor,
    order: input.query.order,
    limit: input.query.limit,
    fields: context.fields,
    filters: input.query.filters,
    changesSince: input.query.changesSince,
    resources: context.grant.resources ?? null,
    timeRange: context.grant.time_range ?? null,
  });
  return { ...result, data: result.data.map((record) => projectRecord(record, context.fields)) };
}

export async function executeRecordDetail(input, repository) {
  const context = resolveReadContext(input);
  const record = await repository.getRecord({
    subjectId: input.subjectId,
    stream: context.stream.name,
    recordId: input.recordId,
    grant: context.grant,
    fields: context.fields,
    resources: context.grant.resources ?? null,
    timeRange: context.grant.time_range ?? null,
  });
  if (record == null) {
    throw new CoreOperationError(
      404,
      'not_found',
      `Record '${input.recordId}' not found in stream '${context.stream.name}'`,
    );
  }
  return projectRecord(record, context.fields);
}

function resolveReadContext({ manifest, grant, streamName, query }) {
  const stream = manifest.streams.find((candidate) => candidate.name === streamName);
  if (!stream) {
    throw new CoreOperationError(404, 'not_found', `Stream '${streamName}' not found`);
  }
  const grantStream = (grant.streams ?? []).find((candidate) => candidate.name === streamName);
  if (!grantStream) {
    throw new CoreOperationError(403, 'grant_stream_not_allowed', `Grant does not include stream '${streamName}'.`);
  }
  validateGrantFields(stream, grantStream);

  const requestedFields = resolveRequestedFields(stream, grantStream, query);
  validateFilters(stream, grantStream, query.filters);
  return { stream, grant: grantStream, fields: requestedFields };
}

function validateGrantFields(stream, grantStream) {
  if (grantStream.fields === undefined) return;
  const properties = stream.schema?.properties ?? {};
  if (
    !Array.isArray(grantStream.fields) ||
    grantStream.fields.some((field) => typeof field !== 'string' || !Object.hasOwn(properties, field)) ||
    (stream.schema?.required ?? []).some((field) => !grantStream.fields.includes(field))
  ) {
    throw new CoreOperationError(
      403,
      'grant_invalid',
      `Grant fields for stream '${stream.name}' are not a valid resolved allowlist`,
    );
  }
}

function resolveRequestedFields(stream, grantStream, query) {
  if (query.view && query.fields) {
    throw new CoreOperationError(400, 'invalid_request', 'view and fields are mutually exclusive');
  }

  let requested = query.fields;
  if (query.view) {
    const view = (stream.views ?? []).find((candidate) => candidate.id === query.view);
    if (!view) {
      throw new CoreOperationError(400, 'invalid_request', `Unknown view: ${query.view}`);
    }
    requested = view.fields;
  }

  const properties = stream.schema?.properties ?? {};
  const authorized = grantStream.fields ?? null;
  if (requested) {
    for (const field of requested) {
      if (!Object.hasOwn(properties, field)) {
        throw new CoreOperationError(400, 'unknown_field', `Unknown field: ${field}`);
      }
      if (authorized && !authorized.includes(field)) {
        throw new CoreOperationError(403, 'field_not_granted', `Field '${field}' is not authorized`);
      }
    }
  }

  return [
    ...new Set(
      requested
        ? [...(stream.schema?.required ?? []), ...requested]
        : authorized ?? Object.keys(properties),
    ),
  ];
}

function validateFilters(stream, grantStream, filters) {
  const properties = stream.schema?.properties ?? {};
  for (const field of Object.keys(filters)) {
    if (!Object.hasOwn(properties, field)) {
      throw new CoreOperationError(400, 'unknown_field', `Unknown field: ${field}`);
    }
    if (!isScalarSchema(properties[field])) {
      throw new CoreOperationError(400, 'invalid_request', `Field '${field}' does not support exact filtering`);
    }
    if (grantStream.fields && !grantStream.fields.includes(field)) {
      throw new CoreOperationError(403, 'field_not_granted', `Field '${field}' is not authorized`);
    }
  }
}

function isScalarSchema(schema) {
  const types = Array.isArray(schema?.type) ? schema.type : [schema?.type];
  return types.some((type) => ['string', 'number', 'integer', 'boolean'].includes(type));
}

function projectRecord(record, fields) {
  if (!fields || !record.data || typeof record.data !== 'object') return record;
  const data = {};
  for (const field of fields) {
    if (Object.hasOwn(record.data, field)) data[field] = record.data[field];
  }
  return { ...record, data };
}
