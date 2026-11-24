// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import test from 'node:test';
import { applyTunnelStartupPolicy } from '../startup-config.js';

test('local-only startup disables the unused tunnel before server bootstrap', () => {
  const config = { tunnel: { enabled: true } };

  applyTunnelStartupPolicy(config, false);

  assert.equal(config.tunnel.enabled, false);
});

test('configured remote service startup preserves the tunnel setting', () => {
  const config = { tunnel: { enabled: true } };

  applyTunnelStartupPolicy(config, true);

  assert.equal(config.tunnel.enabled, true);
});

test('local-only startup creates tunnel config when absent', () => {
  const config = {};

  applyTunnelStartupPolicy(config, false);

  assert.deepEqual(config.tunnel, { enabled: false });
});
