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

// Round 9 (F2): one function decides who an address works for, and the page's phrase comes from it.
test("an address says where it works: this computer, your own network, or anywhere", async () => {
  const { addressReach } = await import("./remote-access.ts");
  for (const origin of ["http://localhost:3000", "http://127.0.0.1:18702", "http://[::1]:3000"])
    assert.deepEqual(addressReach(origin), { kind: "this-computer", phrase: "only works on this computer" }, origin);
  for (const origin of ["http://192.168.1.10:3000", "http://10.0.0.4", "http://nas.local:3000", "http://mybox:3000"])
    assert.deepEqual(addressReach(origin), { kind: "private-network", phrase: "only works on your own network" }, origin);
  assert.deepEqual(addressReach("https://data.example.com"), { kind: "public", phrase: null });
  // An address that cannot be read is not offered as usable from the internet.
  for (const bad of ["not a url", "ftp://nas", "http://user:pw@nas:3000"]) assert.deepEqual(addressReach(bad), { kind: "unusable", phrase: null }, bad);
});

// Round 10 (R1): every boundary of the address classes, one table.
test("address classes at their boundaries", async () => {
  const { addressReach } = await import("./remote-access.ts");
  const table: [string, string][] = [
    ["http://localhost.:3000", "this-computer"], ["http://127.255.255.254", "this-computer"], ["http://[::1]", "this-computer"],
    ["http://100.64.0.1", "private-network"], ["http://100.127.255.255", "private-network"], ["http://100.63.255.255", "public"], ["http://100.128.0.1", "public"],
    ["http://169.254.1.1", "private-network"], ["http://172.15.0.1", "public"], ["http://172.16.0.1", "private-network"], ["http://172.31.255.255", "private-network"], ["http://172.32.0.1", "public"],
    ["http://[fe80::1]", "private-network"], ["http://[febf::1]", "private-network"], ["http://[fec0::1]", "public"], ["http://[fc00::1]", "private-network"], ["http://[fdff::1]", "private-network"], ["http://[fe00::1]", "public"],
    ["http://nas.local.:3000", "private-network"], ["http://nas.", "private-network"], ["https://data.example.com.", "public"], ["https://data.example.com", "public"],
    ["http://0.0.0.0:3000", "unusable"], ["http://[::]:3000", "unusable"],
  ];
  for (const [origin, kind] of table) assert.equal(addressReach(origin).kind, kind, origin);
});

test("the endpoint and the command are built from the origin alone", async () => {
  const { mcpEndpoint } = await import("./remote-access.ts");
  const { claudeCodeCommand } = await import("./assistant-instructions.ts");
  assert.equal(mcpEndpoint("https://data.example.com/"), "https://data.example.com/mcp");
  assert.equal(mcpEndpoint("https://data.example.com:8443/app?x=1#top"), "https://data.example.com:8443/mcp");
  assert.match(claudeCodeCommand("https://data.example.com/path?x=1"), /'https:\/\/data\.example\.com\/mcp'$/);
});
