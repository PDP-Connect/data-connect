// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
let credentialsRead = 0;
mock.module(new URL('../lib/owner-token.ts', import.meta.url).href, { namedExports: {
  getRsInternalUrl: () => 'http://fixture.invalid',
  getOwnerToken: async () => { credentialsRead++; return 'fixture-owner-credential'; },
} });
let loaded: Promise<typeof import('./reachability-forward.ts')> | undefined;
const load = () => loaded ??= import('./reachability-forward.ts');

test('encoded path traversal cannot forward the owner credential outside reachability', async () => {
  const { forwardReachability } = await load();
  const fetchMock = mock.method(globalThis, 'fetch', async () => { throw new Error('Unexpected forwarding'); });
  try {
    for (const path of ['/../remote-access/config', '/%2e%2e/remote-access/config', '/%2E%2E/%2E%2E/password']) {
      await assert.rejects(forwardReachability(path), /Invalid remote access path/);
    }
    assert.equal(credentialsRead, 0);
    assert.equal(fetchMock.mock.callCount(), 0);
  } finally { fetchMock.mock.restore(); }
});

test('an allowed draft read stays in the authenticated route family', async () => {
  const { forwardReachability } = await load();
  const fetchMock = mock.method(globalThis, 'fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    assert.equal(String(input), 'http://fixture.invalid/v1/owner/reachability/drafts/draft-one?providerId=opaque');
    assert.equal((init?.headers as Record<string, string>).Authorization, 'Bearer fixture-owner-credential');
    return new Response(JSON.stringify({ data: { draftId: 'draft-one' } }), { status: 200 });
  });
  try {
    assert.deepEqual(await forwardReachability('/drafts/draft-one?providerId=opaque'), { status: 200, result: { ok: true, data: { draftId: 'draft-one' } } });
  } finally { fetchMock.mock.restore(); }
});

test('a known error code returns its plain message and keeps the server sentence for Details', async () => {
  const { forwardReachability } = await load();
  const fetchMock = mock.method(globalThis, 'fetch', async () =>
    new Response(JSON.stringify({ error: { code: 'host_path_too_long', message: 'The reachability operation could not complete.' } }), { status: 409 }));
  try {
    assert.deepEqual(await forwardReachability('/state'), {
      status: 409,
      result: {
        ok: false,
        code: 'host_path_too_long',
        message: "DataConnect's data folder path is too long for remote access.",
        serverMessage: 'The reachability operation could not complete.',
      },
    });
  } finally { fetchMock.mock.restore(); }
});

test('an unknown code gets the generic message; a dead service gets the background-service message', async () => {
  const { forwardReachability } = await load();
  let mode: 'unknown' | 'down' = 'unknown';
  const fetchMock = mock.method(globalThis, 'fetch', async () => {
    if (mode === 'down') throw new TypeError('fetch failed');
    return new Response(JSON.stringify({ error: { code: 'brand_new_code' } }), { status: 409 });
  });
  try {
    const unknown = (await forwardReachability('/state')).result;
    assert.equal(unknown.ok, false);
    assert.equal(!unknown.ok && unknown.message, "Remote access couldn't turn on. Try again, or copy the details for support.");
    assert.equal(!unknown.ok && unknown.code, 'brand_new_code');
    mode = 'down';
    const down = await forwardReachability('/state');
    assert.equal(down.status, 502);
    assert.equal(!down.result.ok && down.result.code, 'service_unreachable');
    assert.match(!down.result.ok ? down.result.message : '', /background service isn't running/);
  } finally { fetchMock.mock.restore(); }
});

test('a request that outlives its deadline is reported as slow; one the browser dropped is not', async (t) => {
  const { forwardReachability, FORWARD_DEADLINE_MS } = await load();
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const hang = (_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_, reject) => {
    init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
  });
  const fetchMock = mock.method(globalThis, 'fetch', hang);
  try {
    const slow = forwardReachability('/catalog');
    await new Promise((resolve) => setImmediate(resolve));
    t.mock.timers.tick(FORWARD_DEADLINE_MS);
    const slowResult = await slow;
    assert.equal(slowResult.status, 504);
    assert.equal(!slowResult.result.ok && slowResult.result.code, 'reachability_unavailable');
    const gone = new AbortController();
    const dropped = forwardReachability('/catalog', undefined, gone.signal);
    await new Promise((resolve) => setImmediate(resolve));
    gone.abort();
    const droppedResult = await dropped;
    assert.equal(droppedResult.status, 502, 'the browser leaving is not a slow service');
  } finally { fetchMock.mock.restore(); }
});

test('a request the browser already dropped never reaches the reference server', async () => {
  const { forwardReachability } = await load();
  const fetchMock = mock.method(globalThis, 'fetch', (_input: RequestInfo | URL, init?: RequestInit) =>
    init?.signal?.aborted ? Promise.reject(new DOMException('aborted', 'AbortError')) : Promise.resolve(new Response('{}')));
  try {
    const gone = new AbortController();
    gone.abort();
    const result = await forwardReachability('/state', undefined, gone.signal);
    assert.equal(result.status, 502);
    assert.equal(fetchMock.mock.calls.every((call) => call.arguments[1]?.signal?.aborted), true);
  } finally { fetchMock.mock.restore(); }
});
