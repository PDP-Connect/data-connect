// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import test from 'node:test';
import { mountOwnerRemoteAccess } from '../server/routes/owner-remote-access.ts';
import type { ReachabilityService } from '../server/reachability/service.ts';

test('legacy facade refuses mutation and never reads or returns the credential store', () => {
  const routes = new Map<string, unknown[]>();
  const token = () => {}, owner = () => {}, csrf = () => {};
  const app = {
    get: (path: string, ...handlers: unknown[]) => routes.set(`GET ${path}`, handlers),
    post: (path: string, ...handlers: unknown[]) => routes.set(`POST ${path}`, handlers),
  };
  mountOwnerRemoteAccess(app, { service: null, requireToken: token, requireOwner: owner, requireCsrf: csrf });
  for (const [key, handlers] of routes) {
    assert.equal(handlers[0], token); assert.equal(handlers[1], owner);
    if (key.startsWith('POST')) assert.equal(handlers[2], csrf);
    const captured = { status: 200, value: undefined as unknown };
    const response = { status: (status: number) => { captured.status = status; return response; }, json: (value: unknown) => { captured.value = value; } };
    (handlers.at(-1) as (request: unknown, response: unknown) => void)({}, response);
    assert.equal(captured.status, 409);
    assert.deepEqual(captured.value, { error: { code: 'reachability_v2_required', message: 'Use the reachability settings to inspect or change this instance.' } });
  }
});

test('legacy facade represents confirmed Off only, never an unknown provider', () => {
  let handler: (request: unknown, response: unknown) => void = () => {};
  let active = false;
  const app = {
    get: (path: string, ...handlers: unknown[]) => { if (path.endsWith('/config')) handler = handlers.at(-1) as typeof handler; },
    post: () => {},
  };
  const service = { state: () => ({ starting: false, lifecycle: { confinement: { known: true, value: true } }, routes: active ? [{ cleanup: { state: 'none' } }] : [] }) } as unknown as ReachabilityService;
  mountOwnerRemoteAccess(app, { service, requireToken: () => {}, requireOwner: () => {}, requireCsrf: () => {} });
  const captured = { status: 200, value: undefined as unknown };
  const response = { status: (status: number) => { captured.status = status; return response; }, json: (value: unknown) => { captured.value = value; } };
  handler({}, response);
  assert.equal((captured.value as { data: { posture: string } }).data.posture, 'off');
  active = true; handler({}, response);
  assert.equal(captured.status, 409);
});
