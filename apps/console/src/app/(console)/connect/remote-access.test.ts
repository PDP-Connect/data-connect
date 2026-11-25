// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import { needsRemoteAccess } from "./remote-access.ts";

test("private and local addresses need remote access, including bracketed IPv6 hosts", () => {
  for (const origin of [
    "http://localhost:3000",
    "http://192.168.1.10:3000",
    "http://[::1]:3000",
    "http://[fd12::1]:3000",
    "http://[fe80::1]:3000",
  ]) {
    assert.equal(needsRemoteAccess(origin), true, origin);
  }
  assert.equal(needsRemoteAccess("https://data.example.com"), false);
});
