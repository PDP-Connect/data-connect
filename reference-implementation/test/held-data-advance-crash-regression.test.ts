// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { test } from 'node:test';
import { tempDir } from './helpers/held-data-sim.ts';
import { HeldDataAuthority } from '../lib/held-data/authority.ts';
import { TrainingAuthorityStore } from '../lib/training-lease/authority-store.ts';

test('accepted advance election must constrain leases after a crash between ending and activation', () => {
  const dir = tempDir('pdpp-held-advance-crash-');
  let now = 1800000000000;
  const journalPath = join(dir, 'journal');
  const options = { journalPath, epochMarkerPath: join(dir, 'evidence'), now: () => now };
  const held = HeldDataAuthority.open(options);
  for (const grantId of ['acquisition', 'training']) held.registerGrant({grantId, clientId:'app', subjectId:'owner', confidential:false, streams:['messages'], expiresAtMs:null});
  const leaseOptions = {journalPath, storePath:join(dir,'training.sqlite'), issuer:'https://as.example', nodeId:'review', now:()=>now};
  let leases = TrainingAuthorityStore.open(leaseOptions);
  leases.createAuthority({grantId:'training', clientId:'app', subjectId:'owner', trainingExpiresAtMs:now+86400000});
  held.electAdvance('acquisition'); // acknowledged before the crash
  now += 1000;
  const originalWrite = fs.writeSync;
  fs.writeSync = ((fd: number, data: unknown, ...args: unknown[]) => {
    if (typeof data === 'string' && data.includes('"t":"erase"')) throw new Error('injected crash before erase append');
    return (originalWrite as Function)(fd,data,...args);
  }) as typeof fs.writeSync;
  syncBuiltinESMExports();
  try {
    assert.throws(()=>held.end({grantId:'acquisition', path:'owner_withdrawal', disposition:'keep'}), /injected crash/);
  } finally {
    fs.writeSync = originalWrite;
    syncBuiltinESMExports();
  }
  leases.close();
  const reopened = HeldDataAuthority.open(options);
  leases = TrainingAuthorityStore.open(leaseOptions);
  const [answer] = reopened.status({clientId:'app', grantIds:new Set(['acquisition']), clientAuthenticated:false}, ['acquisition']);
  assert.ok(answer && !('error' in answer));
  assert.equal(answer.ordinary_use, 'stopped');
  const result = leases.issueLease({grantId:'training', clientId:'app', acquisitionGrantIds:['acquisition']});
  now += 7200000;
  const renewed = leases.issueLease({grantId:'training', clientId:'app', acquisitionGrantIds:['acquisition']});
  console.log(JSON.stringify({lost:reopened.lost, lifecycle:answer.ordinary_use, leaseIssued:result.ok,renewedAfterTwoHours:renewed.ok}));
  leases.close();
  assert.equal(result.ok, false, 'a durably ended grant with an acknowledged advance instruction is erased');
});
