// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
let credentialsRead = 0;
mock.module(new URL('../lib/dashboard-access.ts', import.meta.url).href, { namedExports: { requireDashboardAccess: async () => {} } });
mock.module(new URL('../lib/owner-token.ts', import.meta.url).href, { namedExports: {
  getRsInternalUrl: () => 'http://fixture.invalid',
  getOwnerToken: async () => { credentialsRead++; return 'fixture-owner-credential'; },
} });
let loaded: Promise<typeof import('./reachability-actions.ts')> | undefined;
const load = () => loaded ??= import('./reachability-actions.ts');

test('encoded path traversal cannot forward the owner credential outside reachability', async () => {
  const { requestReachability } = await load();
  const fetchMock = mock.method(globalThis, 'fetch', async () => { throw new Error('Unexpected forwarding'); });
  try {
    for (const path of ['/../remote-access/config', '/%2e%2e/remote-access/config', '/%2E%2E/%2E%2E/password']) {
      await assert.rejects(requestReachability(path), /Invalid remote access path/);
    }
    assert.equal(credentialsRead, 0);
    assert.equal(fetchMock.mock.callCount(), 0);
  } finally { fetchMock.mock.restore(); }
});

test('an allowed draft read stays in the authenticated route family', async () => {
  const { requestReachability } = await load();
  const fetchMock = mock.method(globalThis, 'fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    assert.equal(String(input), 'http://fixture.invalid/v1/owner/reachability/drafts/draft-one?providerId=opaque');
    assert.equal((init?.headers as Record<string, string>).Authorization, 'Bearer fixture-owner-credential');
    return new Response(JSON.stringify({ data: { draftId: 'draft-one' } }), { status: 200 });
  });
  try {
    assert.deepEqual(await requestReachability('/drafts/draft-one?providerId=opaque'), { ok: true, data: { draftId: 'draft-one' } });
  } finally { fetchMock.mock.restore(); }
});

test('a known error code returns its plain message and keeps the server sentence for Details', async () => {
  const { requestReachability } = await load();
  const fetchMock = mock.method(globalThis, 'fetch', async () =>
    new Response(JSON.stringify({ error: { code: 'host_path_too_long', message: 'The reachability operation could not complete.' } }), { status: 409 }));
  try {
    assert.deepEqual(await requestReachability('/state'), {
      ok: false,
      code: 'host_path_too_long',
      message: "DataConnect's data folder path is too long for remote access.",
      serverMessage: 'The reachability operation could not complete.',
    });
  } finally { fetchMock.mock.restore(); }
});

test('an unknown code gets the generic message; a dead service gets the background-service message', async () => {
  const { requestReachability } = await load();
  let mode: 'unknown' | 'down' = 'unknown';
  const fetchMock = mock.method(globalThis, 'fetch', async () => {
    if (mode === 'down') throw new TypeError('fetch failed');
    return new Response(JSON.stringify({ error: { code: 'brand_new_code' } }), { status: 409 });
  });
  try {
    const unknown = await requestReachability('/state');
    assert.equal(unknown.ok, false);
    assert.equal(!unknown.ok && unknown.message, "Remote access couldn't turn on. Try again, or copy the details for support.");
    assert.equal(!unknown.ok && unknown.code, 'brand_new_code');
    mode = 'down';
    const down = await requestReachability('/state');
    assert.equal(!down.ok && down.code, 'service_unreachable');
    assert.match(!down.ok ? down.message : '', /background service isn't running/);
  } finally { fetchMock.mock.restore(); }
});
