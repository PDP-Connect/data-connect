// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import test from "node:test"

test("browser namespace keeps home ancestry owned and network isolated while public inventory runs", () => {
  const result = spawnSync(
    process.execPath,
    [
      "e2e/owned-root-sandbox.mjs",
      "--",
      process.execPath,
      "--input-type=module",
      "--eval",
      `
    import assert from 'node:assert/strict';
    import {stat} from 'node:fs/promises';
    import {networkInterfaces} from 'node:os';
    import {createGozar} from '@tnunamak/gozar';
    const inventory = await createGozar().listProviders({home:process.env.TEST_TMPDIR+'/gozar'});
    assert.ok(inventory.providers.length);
    assert.ok([0,process.getuid()].includes((await stat('/')).uid));
    assert.ok(Object.values(networkInterfaces()).flat().every(address=>address.internal));
    console.log('public inventory and isolated ownership passed');
  `,
    ],
    { encoding: "utf8", timeout: 30000 }
  )
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /public inventory and isolated ownership passed/)
})
