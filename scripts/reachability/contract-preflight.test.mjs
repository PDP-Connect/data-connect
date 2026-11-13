// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { createGozar } from '@tnunamak/gozar';

// This is an artifact preflight, not a substitute for the owner HTTP/DOM journey.
// Missing contract methods must fail before a host can accidentally use a fallback.
const required = [
  'listProviders', 'beginConfigurationDraft', 'commitConfigurationDraft',
  'discardConfigurationDraft', 'storeSecret', 'discardSecret', 'catalogRoutes',
  'runSetupAction', 'expose', 'ensureRoute', 'routeStatus', 'watchRoutes', 'closeRoute',
];

test('installed artifact exposes the frozen host embedding boundary', async () => {
  const api = createGozar();
  const missing = required.filter(name => typeof api[name] !== 'function');
  const artifactRoot = dirname(fileURLToPath(import.meta.resolve('@tnunamak/gozar/package.json')));
  // Read registry DATA to account for blocked pairs. Never import provider implementation modules.
  const manifest = JSON.parse(await readFile(resolve(artifactRoot, 'adapters/manifest.json'), 'utf8'));
  const matrix = [];
  for (const entry of manifest.providers) {
    const definition = JSON.parse(await readFile(resolve(artifactRoot, 'adapters', entry.definition), 'utf8'));
    for (const usage of (definition.adapter ?? definition).supportedKinds) {
      matrix.push({ providerId: entry.id, usage, status: 'blocked', reason: missing.length
        ? `embedding-contract-missing:${missing.join(',')}` : 'owner-http-and-browser-journey-not-implemented' });
    }
  }
  assert.ok(matrix.length > 0, 'Registry must account for executable provider/usage pairs');
  const output = process.env.GOZAR_COVERAGE_MATRIX;
  assert.ok(output, 'Set GOZAR_COVERAGE_MATRIX to an external evidence file');
  await mkdir(dirname(resolve(output)), { recursive: true });
  await writeFile(output, `${JSON.stringify({ stage: 'preflight', matrix }, null, 2)}\n`);
  assert.deepEqual(missing, [], 'Release BLOCKED: installed factory lacks required public contract methods');
  assert.fail('Release BLOCKED: owner HTTP, controller secret-backend and browser journeys remain unimplemented');
});
