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

test("public names that start like private IPv6 prefixes do not need remote access", () => {
  // Only an IPv6 literal (it holds a colon) can be in fc00::/7 or fe80::/10.
  for (const origin of ["https://fcbarcelona.example", "https://fd.example", "https://fe80.example"]) {
    assert.equal(needsRemoteAccess(origin), false, origin);
  }
});
