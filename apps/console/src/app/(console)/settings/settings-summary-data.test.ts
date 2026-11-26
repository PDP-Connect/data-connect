// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import test, { mock } from "node:test";
let failed = false;
let address = 'https://maple.example.test/path';
const data = async () => { if (failed) throw Error('unavailable'); return { data: [{ status: 'active', stale: false, last_ingest_at: '2026-11-26' }] }; };
mock.module('server-only', { namedExports: {} });
mock.module(new URL('../lib/ref-client.ts', import.meta.url).href, { namedExports: { listOwnerIssuedClients: data, listDeviceExporters: data, listClientEventSubscriptions: data, getDeploymentDiagnostics: async () => ({ environment: [{ name: 'PDPP_REFERENCE_ORIGIN', provenance: 'present', value: address }] }) } });
mock.module(new URL('../sources/add/add-source-catalog-read.ts', import.meta.url).href, { namedExports: { readAddSourceCatalog: async () => { if (failed) throw Error('unavailable'); return { catalog: [], existingConnectionCounts: {}, lifecycleFor: () => null }; } } });
test('summary counts successful reads and uses only the configured web address', async () => {
  const { loadSettingsSummary } = await import('./settings-summary-data.ts');
  assert.deepEqual(await loadSettingsSummary(), { tokens: 1, collectors: 1, webhooks: 1, updates: 0, publicAddress: 'https://maple.example.test' });
});
test('unavailable reads stay unknown, and malformed addresses are not printed', async () => {
  failed = true; address = 'not a web address';
  const { loadSettingsSummary } = await import('./settings-summary-data.ts');
  assert.deepEqual(await loadSettingsSummary(), { tokens: null, collectors: null, webhooks: null, updates: null, publicAddress: null });
});
