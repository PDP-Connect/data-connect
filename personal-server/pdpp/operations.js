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
  const declared = new Set(manifest.streams.map((stream) => stream.name));
  return Promise.resolve(repository.listStreams({ subjectId, grant, manifest }))
    .then((streams) => streams.filter((stream) => allowed.has(stream.name) && declared.has(stream.name)));
}

export async function executeRecordsList(input, repository) {
  const context = resolveReadContext(input);
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

  const requestedFields = resolveRequestedFields(stream, grantStream, query);
  validateFilters(stream, grantStream, query.filters);
  return { stream, grant: grantStream, fields: requestedFields };
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

  if (!requested && !authorized) return null;
  const fields = new Set(requested ?? authorized);
  for (const field of stream.schema?.required ?? []) fields.add(field);
  return [...fields];
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
