// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import test from 'node:test';
import { createPreparedFixture } from './prepared-fixture.mjs';

test('closing a historical route never stops or changes the current route', { timeout: 30000 }, async () => {
  const fixture = await createPreparedFixture();
  async function operation(path, body) {
    const pending = await fixture.api.call(path, body);
    const deadline = Date.now() + 10000;
    for (;;) {
      const result = await fixture.api.call(`/operations/${pending.operationId}`);
      if (result.stage !== 'applying') { assert.equal(result.stage, 'settled'); return pending.operationId; }
      assert.ok(Date.now() < deadline, 'Owner operation did not settle');
      await new Promise(resolve => setTimeout(resolve, 20));
    }
  }
  async function start() {
    const review = await fixture.api.call(`/drafts/${fixture.draftId}/review`, { usage: 'attached' });
    const id = await operation('/operations', { reviewId: review.id, kind: 'route', consentFactsDigest: review.candidate.consentFactsDigest, acknowledgeDisconnect: true });
    const state = await fixture.api.call('/state');
    return state.routes.find(route => route.operationId === id);
  }
  try {
    const first = await start(); assert.ok(first);
    await operation(`/routes/${first.handle.id}/stop`, { generation: first.handle.generation, acknowledgeDisconnect: true });
    const second = await start(); assert.ok(second); assert.notEqual(second.handle.id, first.handle.id);
    const before = await fixture.api.call('/state');
    assert.equal(before.lifecycle.handle.id, second.handle.id);
    await operation(`/routes/${first.handle.id}/stop`, { generation: first.handle.generation, acknowledgeDisconnect: true });
    const after = await fixture.api.call('/state');
    assert.equal(after.lifecycle.handle.id, second.handle.id);
    assert.equal(after.lifecycle.phase, before.lifecycle.phase);
    const current = after.routes.find(route => route.handle.id === second.handle.id);
    assert.equal(current.published, second.origin);
    assert.notEqual(current.cleanup.state, 'confirmed');
    await operation(`/routes/${second.handle.id}/stop`, { generation: second.handle.generation, acknowledgeDisconnect: true });
  } finally { await fixture.close(); }
});

test('malformed secret submissions return a projected parser error without credential bytes', async () => {
  const fixture = await createPreparedFixture();
  try {
    const response = await fixture.api.request('/drafts', { providerId: fixture.request.providerId }, { rawBody: `{"secret":${fixture.canary}}` });
    assert.equal(response.status, 400);
    assert.equal(response.error.code, 'invalid_input');
    assert.ok(!JSON.stringify(response).includes(fixture.canary));
  } finally { await fixture.close(); }
});
