// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import test from "node:test";
import { buildSignedInModel, publicSessionAddress } from "./signed-in-model.ts";
import { buildSettingsPractice } from "./settings-practice.ts";
test('thirteen identical labels retain distinct rows, current first and five initially', () => {
  const input = buildSettingsPractice('sessions-thirteen')!.inventory.sessions;
  const model = buildSignedInModel(input);
  assert.equal(model.total, 13); assert.equal(model.rows.length, 5);
  assert.equal(model.rows[0]?.current, true);
  assert.equal(buildSignedInModel(input, true).rows.length, 13);
  assert.equal(new Set(model.rows.map(row => row.id)).size, 5);
});
test('only public IPv4 and IPv6 addresses are shown', () => {
  for (const address of [null, '127.0.0.1', '10.0.0.2', '192.168.0.1', '172.16.0.1', '169.254.1.2', '100.64.0.1', '::1', 'fc00::1', 'fe80::1', '::ffff:192.168.1.1', 'not an address']) assert.equal(publicSessionAddress(address), null, String(address));
  for (const address of ['8.8.8.8', '2606:4700:4700::1111']) assert.equal(publicSessionAddress(address), address);
});
