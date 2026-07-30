import assert from 'node:assert/strict';
import test from 'node:test';

import { createCoreApp } from '../index.js';

const githubManifest = {
  protocol_version: '0.1.0',
  connector_id: 'https://registry.pdpp.org/connectors/github',
  streams: [
    {
      name: 'user',
      primary_key: ['id'],
      cursor_field: 'source_updated_at',
      consent_time_field: 'source_created_at',
      selection: { fields: true, resources: true },
      schema: {
        type: 'object',
        required: ['id'],
        properties: {
          id: { type: 'string' },
          login: { type: 'string' },
          source_created_at: { type: 'string' },
          source_updated_at: { type: 'string' },
        },
      },
      views: [{ id: 'identity', fields: ['id', 'login'] }],
    },
    {
      name: 'repositories',
      primary_key: ['id'],
      cursor_field: 'source_updated_at',
      consent_time_field: 'source_created_at',
      selection: { fields: true, resources: true },
      schema: {
        type: 'object',
        required: ['id'],
        properties: {
          id: { type: 'string' },
          name: { type: 'string' },
          private: { type: 'boolean' },
          source_created_at: { type: 'string' },
          source_updated_at: { type: 'string' },
        },
      },
      views: [{ id: 'summary', fields: ['id', 'name'] }],
    },
    {
      name: 'starred',
      primary_key: ['id'],
      cursor_field: 'starred_at',
      consent_time_field: 'starred_at',
      selection: { fields: true, resources: true },
      schema: {
        type: 'object',
        required: ['id'],
        properties: {
          id: { type: 'string' },
          name: { type: 'string' },
          starred_at: { type: 'string' },
        },
      },
    },
  ],
};

function makeApp({ grant = defaultGrant(), repository = makeRepository() } = {}) {
  return createCoreApp({
    manifest: githubManifest,
    tokenIntrospector: {
      introspect: async (token) =>
        token === 'good-token'
          ? { active: true, pdpp_token_kind: 'client', subject_id: 'subject_1', grant }
          : { active: false },
    },
    recordsRepository: repository,
    requestId: () => 'req_test_123',
  });
}

function defaultGrant() {
  return {
    streams: [
      {
        name: 'repositories',
        fields: ['id', 'name', 'private', 'source_created_at', 'source_updated_at'],
        resources: ['repo-1'],
        time_range: {
          since: '2026-01-01T00:00:00Z',
          until: '2026-12-31T00:00:00Z',
        },
      },
      { name: 'starred', fields: ['id', 'name', 'starred_at'] },
    ],
  };
}

function makeRepository() {
  return {
    listStreams: async () => [
      { object: 'stream', name: 'user', record_count: 1, last_updated: null },
      { object: 'stream', name: 'repositories', record_count: 3, last_updated: '2026-02-02T00:00:00Z' },
      { object: 'stream', name: 'starred', record_count: 2, last_updated: '2026-02-01T00:00:00Z' },
      { object: 'stream', name: 'not_in_manifest', record_count: 1, last_updated: null },
    ],
    listRecords: async () => ({
      object: 'list',
      data: [{ object: 'record', id: 'repo-1', data: { id: 'repo-1', name: 'core', private: false } }],
      has_more: false,
    }),
    getRecord: async () =>
      ({ object: 'record', id: 'repo-1', data: { id: 'repo-1', name: 'core', private: false } }),
  };
}

function request(app, path, token = 'good-token') {
  return app.request(path, { headers: { Authorization: `Bearer ${token}` } });
}

test('Core stream list exposes only GitHub streams authorized by the introspected grant', async () => {
  const response = await request(makeApp(), '/v1/streams');
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('PDPP-Version'), '0.1.0');
  const body = await response.json();
  assert.deepEqual(body.data.map((stream) => stream.name), ['repositories', 'starred']);
  assert.equal(body.version, '0.1.0');
  assert.equal(body.request_id, 'req_test_123');
  assert.equal(response.headers.get('Request-Id'), 'req_test_123');
});

test('Core stream list carries installed manifest schema metadata for empty streams', async () => {
  const response = await request(makeApp({
    repository: {
      ...makeRepository(),
      listStreams: async () => [
        { object: 'stream', name: 'starred', record_count: 0, last_updated: null },
      ],
    },
  }), '/v1/streams');

  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).data, [
    {
      object: 'stream',
      name: 'starred',
      record_count: 0,
      last_updated: null,
      fields: [
        { name: 'id', type: 'string' },
        { name: 'name', type: 'string' },
        { name: 'starred_at', type: 'string' },
      ],
      primary_key: ['id'],
      timestamp_fields: ['starred_at'],
    },
  ]);
});

test('Core record list clamps limit and preserves cursor, order, grant resources, and time range for the repository port', async () => {
  let received;
  const app = makeApp({
    repository: {
      ...makeRepository(),
      listRecords: async (query) => {
        received = query;
        return { object: 'list', data: [], has_more: true, next_cursor: 'page:2' };
      },
    },
  });

  const response = await request(app, '/v1/streams/repositories/records?limit=101&cursor=page%3A1&order=desc');
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(body.meta.warnings, [{
    code: 'limit_clamped',
    limit: 100,
    message: 'limit was clamped to 100',
  }]);
  assert.equal(body.next_cursor, 'page:2');
  assert.deepEqual(received, {
    subjectId: 'subject_1',
    stream: 'repositories',
    grant: defaultGrant().streams[0],
    cursor: 'page:1',
    order: 'desc',
    limit: 100,
    fields: ['id', 'name', 'private', 'source_created_at', 'source_updated_at'],
    filters: {},
    changesSince: null,
    resources: ['repo-1'],
    timeRange: {
      since: '2026-01-01T00:00:00Z',
      until: '2026-12-31T00:00:00Z',
    },
  });
});

test('Core record list allows exact filters only on authorized scalar fields', async () => {
  let received;
  const app = makeApp({
    repository: {
      ...makeRepository(),
      listRecords: async (query) => {
        received = query;
        return { object: 'list', data: [], has_more: false };
      },
    },
  });

  const allowed = await request(app, '/v1/streams/repositories/records?filter%5Bprivate%5D=false');
  assert.equal(allowed.status, 200);
  assert.deepEqual(received.filters, { private: 'false' });

  const forbidden = await request(app, '/v1/streams/repositories/records?filter%5Bnot_a_field%5D=no');
  assert.equal(forbidden.status, 400);
  assert.equal((await forbidden.json()).error.code, 'unknown_field');

  const narrowed = makeApp({
    grant: {
      streams: [{ name: 'repositories', fields: ['id', 'name', 'source_created_at', 'source_updated_at'] }],
    },
  });
  const unauthorized = await request(narrowed, '/v1/streams/repositories/records?filter%5Bprivate%5D=false');
  assert.equal(unauthorized.status, 403);
  assert.deepEqual(await unauthorized.json(), {
    error: { code: 'field_not_granted', message: "Field 'private' is not authorized", request_id: 'req_test_123' },
    version: '0.1.0',
  });
});

test('Core rejects an unsupported PDPP-Version before reaching either port', async () => {
  const response = await makeApp().request('/v1/streams', {
    headers: { Authorization: 'Bearer good-token', 'PDPP-Version': '9.9.9' },
  });
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), {
    error: { code: 'unsupported_version', message: 'Unsupported PDPP-Version: 9.9.9', request_id: 'req_test_123' },
    version: '0.1.0',
  });
});

test('Core record list enforces fields/view exclusivity and projects the manifest view within the grant', async () => {
  const app = makeApp({
    repository: {
      ...makeRepository(),
      listRecords: async (query) => ({
        object: 'list',
        data: [{ object: 'record', id: 'repo-1', data: { id: 'repo-1', name: 'core', private: false } }],
        has_more: false,
        query,
      }),
    },
  });

  const conflict = await request(app, '/v1/streams/repositories/records?fields=id&view=summary');
  assert.equal(conflict.status, 400);
  assert.equal((await conflict.json()).error.code, 'invalid_request');

  const view = await request(app, '/v1/streams/repositories/records?view=summary');
  assert.equal(view.status, 200);
  assert.deepEqual((await view.json()).data[0].data, { id: 'repo-1', name: 'core' });

  const unknownField = await request(app, '/v1/streams/repositories/records?fields=nope');
  assert.equal(unknownField.status, 400);
  assert.equal((await unknownField.json()).error.code, 'unknown_field');
});

test('Core keeps page and changes_since cursor values in separate repository inputs', async () => {
  let received;
  const app = makeApp({
    repository: {
      ...makeRepository(),
      listRecords: async (query) => {
        received = query;
        return {
          object: 'list', data: [], has_more: false,
          next_changes_since: 'change:17',
        };
      },
    },
  });

  const response = await request(app, '/v1/streams/repositories/records?cursor=page%3A4&changes_since=change%3A16');
  assert.equal(response.status, 200);
  assert.equal(received.cursor, 'page:4');
  assert.equal(received.changesSince, 'change:16');
  assert.equal((await response.json()).next_changes_since, 'change:17');
});

test('Core preserves stable repository pagination boundaries across a cursor round trip', async () => {
  const calls = [];
  const app = makeApp({
    repository: {
      ...makeRepository(),
      listRecords: async (query) => {
        calls.push(query.cursor);
        if (query.cursor == null) {
          return {
            object: 'list',
            data: [
              { object: 'record', id: 'repo-1', data: { id: 'repo-1', name: 'one' } },
              { object: 'record', id: 'repo-2', data: { id: 'repo-2', name: 'two' } },
            ],
            has_more: true,
            next_cursor: 'page:repo-2',
          };
        }
        return {
          object: 'list',
          data: [{ object: 'record', id: 'repo-3', data: { id: 'repo-3', name: 'three' } }],
          has_more: false,
        };
      },
    },
  });

  const first = await (await request(app, '/v1/streams/repositories/records?limit=2')).json();
  const second = await (await request(app, `/v1/streams/repositories/records?limit=2&cursor=${encodeURIComponent(first.next_cursor)}`)).json();

  assert.deepEqual([...first.data, ...second.data].map((record) => record.id), ['repo-1', 'repo-2', 'repo-3']);
  assert.deepEqual(calls, [null, 'page:repo-2']);
  assert.equal(second.next_cursor, undefined);
});

test('Core record detail is grant-scoped and retains stable error/version/request-id envelopes', async () => {
  const app = makeApp();
  const detail = await request(app, '/v1/streams/repositories/records/repo-1?fields=id,name');
  assert.equal(detail.status, 200);
  assert.deepEqual((await detail.json()).data, { id: 'repo-1', name: 'core' });

  const denied = await request(app, '/v1/streams/user/records/user-1');
  assert.equal(denied.status, 403);
  assert.deepEqual(await denied.json(), {
    error: { code: 'grant_stream_not_allowed', message: "Grant does not include stream 'user'.", request_id: 'req_test_123' },
    version: '0.1.0',
  });

  const inactive = await request(app, '/v1/streams', 'bad-token');
  assert.equal(inactive.status, 401);
  assert.deepEqual(await inactive.json(), {
    error: { code: 'authentication_error', message: 'Missing or invalid access token', request_id: 'req_test_123' },
    version: '0.1.0',
  });
});

test('Core rejects malformed authorization and unsupported query shapes instead of ignoring them', async () => {
  const app = makeApp();

  const missingToken = await app.request('/v1/streams');
  assert.equal(missingToken.status, 401);
  assert.equal((await missingToken.json()).error.code, 'authentication_error');

  const unknown = await request(app, '/v1/streams/repositories/records?search=core');
  assert.equal(unknown.status, 400);
  assert.equal((await unknown.json()).error.code, 'invalid_request');

  const invalidOrder = await request(app, '/v1/streams/repositories/records?order=sideways');
  assert.equal(invalidOrder.status, 400);
  assert.equal((await invalidOrder.json()).error.message, 'order must be asc or desc');
});
