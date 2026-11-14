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
      await assert.rejects(requestReachability(path), /Invalid reachability path/);
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
