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

test('acceleration must not erase a pre-issuance advance election from the post-append check', () => {
  const dir = tempDir('pdpp-held-advance-race-');
  const now = 1800000000000;
  const journalPath = join(dir, 'journal');
  const held = HeldDataAuthority.open({journalPath, now:()=>now});
  held.registerGrant({grantId:'acquisition', clientId:'app', subjectId:'owner', confidential:false, streams:['messages'], expiresAtMs:now+900000});
  const leases = TrainingAuthorityStore.open({journalPath,storePath:join(dir,'training.sqlite'),issuer:'https://as.example',nodeId:'review',now:()=>now,
    afterIssueJournaledForTest:()=>{held.requestErasure({grantId:'acquisition', origin:'owner_election'});}});
  leases.createAuthority({grantId:'training', clientId:'app', subjectId:'owner', trainingExpiresAtMs:now+86400000});
  const originalWrite = fs.writeSync;
  let injected = false;
  fs.writeSync = ((fd: number, data: unknown, ...args: unknown[]) => {
    if (!injected && typeof data === 'string' && data.includes('"t":"issue"')) {
      injected = true;
      held.electAdvance('acquisition'); // durable election BEFORE issue entry
    }
    return (originalWrite as Function)(fd,data,...args);
  }) as typeof fs.writeSync;
  syncBuiltinESMExports();
  let result: ReturnType<typeof leases.issueLease>;
  try {
    result = leases.issueLease({grantId:'training',clientId:'app',acquisitionGrantIds:['acquisition']});
  } finally {
    fs.writeSync = originalWrite;
    syncBuiltinESMExports();
  }
  const events = fs.readFileSync(journalPath,'utf8').trim().split('\n').map(l=>JSON.parse(l).t).filter(t=>['hd_advance','issue','hd_end','erase'].includes(t));
  console.log(JSON.stringify({events,leaseIssued:result.ok,expiryAfterPriorKnownDeadlineMs:result.ok ? result.claims.exp*1000-(now+900000) : null}));
  leases.close();
  assert.equal(result.ok,false,'a lease crossing the pre-issuance election deadline must be refused');
});
