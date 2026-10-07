// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { parseArgs, removeStage, verifyRelocatedArtifact } from './verify-artifact-relocatable.js';

describe('relocatable artifact verifier', () => {
  it('allows a Windows cold start longer than the observed 76s by default', () => {
    assert.ok(parseArgs([]).timeoutSeconds > 90);
  });

  it('does not let a locked temp directory replace the verdict', () => {
    const lockedRemove = () => {
      throw Object.assign(new Error('EPERM, Permission denied'), { code: 'EPERM' });
    };
    assert.doesNotThrow(() => removeStage('C:\\locked', lockedRemove));
  });

  it(
    'reports why the artifact failed, with its output',
    { skip: process.platform === 'win32' && 'uses a POSIX shell script as the executable' },
    async () => {
      const dist = mkdtempSync(join(tmpdir(), 'verify-relocatable-test-'));
      try {
        mkdirSync(join(dist, 'node_modules'));
        const executable = join(dist, 'personal-server');
        writeFileSync(executable, '#!/bin/sh\necho "Cannot find module x"\nexit 3\n');
        chmodSync(executable, 0o755);
        await assert.rejects(verifyRelocatedArtifact({ dist, timeoutSeconds: 10 }), error => {
          assert.match(error.message, /exited \(code 3/);
          assert.match(error.message, /Cannot find module x/);
          return true;
        });
      } finally {
        rmSync(dist, { recursive: true, force: true });
      }
    }
  );
});
