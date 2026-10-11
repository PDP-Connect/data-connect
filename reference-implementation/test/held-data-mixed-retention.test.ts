// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ToyApp } from '../examples/held-data-toy-app/app.ts';
import { MemoryClientCheckpointStorage } from '../lib/held-data/checkpoint.ts';
import type { HeldStore } from '../lib/held-data/client.ts';
import { HeldDataClient, DAY_MS as DAY } from '../lib/held-data/client.ts';

const T0 = Date.UTC(2026, 9, 12);
test('switching from acquire to acquireRecords preserves the old records retention ceiling', async () => {
  let now = T0;
  const app = new ToyApp();
  const client = new HeldDataClient({ now: () => now, store: app,
    status: async () => ({ok: false, reason: 'offline'}),
    policy: {retentionCeilingMs: 2 * DAY, longStopMs: null} });
  // Existing integration stores a legacy delivery after acquire succeeds.
  assert.equal(client.acquire('g'), true);
  app.sync('g', [{id: 'old', stream: 'messages', text: 'oldword'}]);
  // The integration begins supplying per-record metadata on its next delivery.
  app.attach(client);
  now += DAY;
  app.sync('g', [{id: 'new', stream: 'messages', text: 'newword'}]);
  now += DAY;
  await client.tick();
  const atOldCeiling = app.records.get('g')?.map(r => r.id);
  now += DAY;
  await client.tick();
  console.log(JSON.stringify({atOldCeiling, atNewCeiling: app.records.get('g')?.map(r => r.id),
    declaredDeleted: client.grantState('g')?.deletedAt !== null, deleteBy: client.deleteBy('g'),
    nextAttemptAt: client.nextAttemptAt, oldIndexRemains: app.index.has('oldword')}));
  assert.deepEqual(atOldCeiling, ['new'], 'the legacy record must still expire at its original ceiling');
});


test('a mixed acquisition survives restart without abandoning its old retention clock', async () => {
  let now = T0;
  const storage = new MemoryClientCheckpointStorage();
  const app = new ToyApp();
  const make = (initialize = false) => new HeldDataClient({ now: () => now, storage, initialize, store: app,
    status: async () => ({ ok: false, reason: 'offline' }),
    policy: { retentionCeilingMs: 2 * DAY, longStopMs: null } });
  const first = make(true);
  assert.equal(first.acquire('g'), true);
  app.sync('g', [{ id: 'old', stream: 'messages', text: 'oldword' }]);
  now += DAY;
  app.attach(first);
  app.sync('g', [{ id: 'new', stream: 'messages', text: 'newword' }]);
  const resumed = make();
  app.attach(resumed);
  assert.equal(resumed.deleteBy('g'), T0 + 2 * DAY);
  now += DAY;
  await resumed.tick();
  assert.deepEqual(app.records.get('g')?.map(r => r.id), ['new']);
  assert.equal(app.index.has('oldword'), false);
  assert.equal(resumed.deleteBy('g'), T0 + 3 * DAY);
});

test('a store without complete record inventory keeps the original whole-copy bound across restart', async () => {
  let now = T0;
  const app = new ToyApp();
  const storage = new MemoryClientCheckpointStorage();
  const store: HeldStore = {
    grantIds: () => app.grantIds(),
    dispose: (id, scope) => app.dispose(id, scope),
    disposeRecords: (id, records) => app.disposeRecords(id, records),
  };
  const make = (initialize = false) => new HeldDataClient({ now: () => now, storage, initialize, store,
    status: async () => ({ ok: false, reason: 'offline' }),
    policy: { retentionCeilingMs: 2 * DAY, longStopMs: null } });
  const first = make(true);
  first.acquire('g');
  app.sync('g', [{ id: 'old', stream: 'messages', text: 'oldword' }]);
  now += DAY;
  app.attach(first);
  app.sync('g', [{ id: 'new', stream: 'messages', text: 'newword' }]);
  const resumed = make();
  assert.equal(resumed.deleteBy('g'), T0 + 2 * DAY);
  now += DAY;
  await resumed.tick();
  assert.deepEqual(app.holds('g'), { records: 0, indexEntries: 0, summary: false });
  assert.equal(resumed.grantState('g')?.deleteReason, 'retention_ceiling');
});
