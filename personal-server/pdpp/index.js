import {
  CoreOperationError,
  DEFAULT_LIMIT,
  MAX_LIMIT,
  executeRecordDetail,
  executeRecordsList,
  executeStreamsList,
} from './operations.js';

const CORE_VERSION = '0.1.0';

/**
 * @typedef {object} TokenIntrospector
 * @property {(token: string) => Promise<{active: boolean, subject_id?: string, grant?: object}>} introspect
 */

/**
 * @typedef {object} GrantScopedRecordsRepository
 * @property {(query: object) => Promise<Array<object>>} listStreams
 * @property {(query: object) => Promise<{object: 'list', data: Array<object>, has_more: boolean}>} listRecords
 * @property {(query: object) => Promise<object | null>} getRecord
 */

/**
 * Build a Fetch-compatible Core resource-server surface.
 *
 * Required ports:
 * - TokenIntrospector#introspect(token) -> { active, subject_id, grant }
 * - GrantScopedRecordsRepository#listStreams/listRecords/getRecord(...)
 *
 * The repository port is deliberately grant-scoped. It must enforce the
 * passed stream grant while it executes the storage query, including resource
 * and time-range constraints. This layer validates and forwards constraints;
 * it never assumes a storage implementation or cursor encoding.
 *
 * @param {{manifest: object, tokenIntrospector: TokenIntrospector, recordsRepository: GrantScopedRecordsRepository, requestId?: () => string}} dependencies
 */
export function createCoreApp({ manifest, tokenIntrospector, recordsRepository, requestId = crypto.randomUUID }) {
  const hasInjectedManifest = Array.isArray(manifest?.streams);
  if (!hasInjectedManifest) {
    throw new TypeError('createCoreApp requires an injected validated manifest');
  }
  const hasTokenIntrospector = typeof tokenIntrospector?.introspect === 'function';
  const hasGrantScopedRepository = [
    recordsRepository?.listStreams,
    recordsRepository?.listRecords,
    recordsRepository?.getRecord,
  ].every((method) => typeof method === 'function');
  if (!hasTokenIntrospector || !hasGrantScopedRepository) {
    throw new TypeError('createCoreApp requires TokenIntrospector and GrantScopedRecordsRepository ports');
  }

  async function fetch(request) {
    const id = requestId();
    try {
      assertVersion(request);
      const identity = await introspect(request, tokenIntrospector);
      const url = new URL(request.url);
      const path = url.pathname.split('/').filter(Boolean);
      if (request.method !== 'GET') throw new CoreOperationError(404, 'not_found', 'Endpoint not found');

      if (path.length === 2 && path[0] === 'v1' && path[1] === 'streams') {
        assertNoQuery(url);
        const data = await executeStreamsList({ subjectId: identity.subject_id, grant: identity.grant, manifest }, recordsRepository);
        return respond(200, { object: 'list', data }, id);
      }

      if (path.length === 5 && path[0] === 'v1' && path[1] === 'streams' && path[3] === 'records') {
        const query = parseReadQuery(url, { detail: true });
        const record = await executeRecordDetail({
          subjectId: identity.subject_id,
          grant: identity.grant,
          manifest,
          streamName: decodeURIComponent(path[2]),
          recordId: decodeURIComponent(path[4]),
          query,
        }, recordsRepository);
        return respond(200, record, id);
      }

      if (path.length === 4 && path[0] === 'v1' && path[1] === 'streams' && path[3] === 'records') {
        const query = parseReadQuery(url);
        const result = await executeRecordsList({
          subjectId: identity.subject_id,
          grant: identity.grant,
          manifest,
          streamName: decodeURIComponent(path[2]),
          query,
        }, recordsRepository);
        const body = { ...result };
        if (query.warning) body.meta = { warnings: [query.warning] };
        return respond(200, body, id);
      }
      throw new CoreOperationError(404, 'not_found', 'Endpoint not found');
    } catch (error) {
      return errorResponse(error, id);
    }
  }

  return {
    fetch,
    request(path, init = {}) {
      return fetch(new Request(new URL(path, 'http://pdpp.local'), init));
    },
  };
}

async function introspect(request, tokenIntrospector) {
  const authorization = request.headers.get('authorization');
  const token = authorization?.match(/^Bearer (.+)$/i)?.[1];
  if (!token) throw new CoreOperationError(401, 'authentication_error', 'Missing or invalid access token');
  const identity = await tokenIntrospector.introspect(token);
  const isActive = identity?.active === true;
  const isClientToken = identity?.pdpp_token_kind === 'client';
  const hasGrant = identity?.grant != null;
  if (!isActive || !isClientToken || !hasGrant) {
    throw new CoreOperationError(401, 'authentication_error', 'Missing or invalid access token');
  }
  return identity;
}

function assertVersion(request) {
  const requested = request.headers.get('PDPP-Version');
  if (requested && requested !== CORE_VERSION) {
    throw new CoreOperationError(400, 'unsupported_version', `Unsupported PDPP-Version: ${requested}`);
  }
}

function assertNoQuery(url) {
  if ([...url.searchParams].length) {
    throw new CoreOperationError(400, 'invalid_request', 'Unknown query parameter');
  }
}

function parseReadQuery(url, { detail = false } = {}) {
  const query = {
    cursor: null,
    changesSince: null,
    order: 'asc',
    limit: detail ? null : DEFAULT_LIMIT,
    fields: null,
    view: null,
    filters: {},
    warning: null,
  };
  const values = new Map();
  for (const [key, value] of url.searchParams) {
    if (values.has(key)) throw new CoreOperationError(400, 'invalid_request', `Repeated query parameter: ${key}`);
    values.set(key, value);
  }
  for (const [key, value] of values) {
    const filter = key.match(/^filter\[([^\]]+)\]$/);
    if (filter && !detail) {
      query.filters[filter[1]] = value;
      continue;
    }
    if (key === 'fields') {
      query.fields = splitFields(value);
    } else if (!detail && key === 'view') {
      query.view = value;
    } else if (!detail && key === 'cursor') {
      query.cursor = value;
    } else if (!detail && key === 'changes_since') {
      query.changesSince = value;
    } else if (!detail && key === 'order') {
      if (!['asc', 'desc'].includes(value)) throw new CoreOperationError(400, 'invalid_request', 'order must be asc or desc');
      query.order = value;
    } else if (!detail && key === 'limit') {
      const requested = Number(value);
      if (!Number.isInteger(requested) || requested < 1) {
        throw new CoreOperationError(400, 'invalid_request', 'limit must be a positive integer');
      }
      query.limit = Math.min(requested, MAX_LIMIT);
      if (requested > MAX_LIMIT) {
        query.warning = {
          code: 'limit_clamped',
          limit: MAX_LIMIT,
          message: `limit was clamped to ${MAX_LIMIT}`,
        };
      }
    } else {
      throw new CoreOperationError(400, 'invalid_request', `Unknown query parameter: ${key}`);
    }
  }
  return query;
}

function splitFields(value) {
  const fields = [...new Set(value.split(',').map((field) => field.trim()).filter(Boolean))];
  if (!fields.length) throw new CoreOperationError(400, 'invalid_request', 'fields must name at least one field');
  return fields;
}

function respond(status, body, requestId) {
  return Response.json(
    { ...body, version: CORE_VERSION, request_id: requestId },
    { status, headers: { 'PDPP-Version': CORE_VERSION, 'Request-Id': requestId, 'X-Request-Id': requestId } },
  );
}

function errorResponse(error, requestId) {
  const stable = error instanceof CoreOperationError
    ? error
    : new CoreOperationError(500, 'internal_error', 'Internal server error');
  return Response.json(
    { error: { code: stable.code, message: stable.message, request_id: requestId }, version: CORE_VERSION },
    { status: stable.status, headers: { 'PDPP-Version': CORE_VERSION, 'Request-Id': requestId, 'X-Request-Id': requestId } },
  );
}
