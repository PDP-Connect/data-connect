// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// The sole effects-harness seam. Fixtures are keyed by exact kind + operation.
// No vocabulary is inferred here; adapters and the published harness own it.
export async function createEffectFixtureHost(createGozarOptions, effects) {
  const testing = await import('@tnunamak/gozar/testing');
  if (typeof testing.createTestingGozar !== 'function') {
    throw Object.assign(new Error('Installed tarball lacks the public effects harness'), {
      code: 'blocked-on-harness',
    });
  }
  return testing.createTestingGozar({ ...createGozarOptions, effects });
}
