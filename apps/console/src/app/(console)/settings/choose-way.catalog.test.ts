// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
// What Remote access recommends and lists for the real Gozar catalog. The same
// outcomes held when the console kept a table keyed by provider id; they now
// follow from each way's reach, lifetime kinds and cost sentence.
import assert from "node:assert/strict";
import test from "node:test";
import { otherWays, recommendedWay } from "./choose-way.ts";
import { realInventory, wayIds } from "./fixtures/real-catalog.ts";

type Inv = Parameters<typeof recommendedWay>[0];
const inv = (value: unknown) => value as Inv;
const caps = {};
const tailscale = (provider: { providerId: string }) => provider.providerId === wayIds.funnel || provider.providerId === wayIds.tailnet;
const withTailscale = (state: string) =>
  inv(realInventory((provider) => {
    if (tailscale(provider)) provider.prerequisites = provider.prerequisites.map((item) => ({ ...(item as object), state }));
  }));

const fresh = inv(realInventory());

test("on a fresh machine the temporary address is recommended: Tailscale being installed does not prove a sign-in", () => {
  assert.equal(recommendedWay(fresh, caps)?.providerId, wayIds.temporary);
});

test("a lasting way the owner already set up is recommended over the temporary address", () => {
  assert.equal(recommendedWay(fresh, caps, {}, new Set([wayIds.funnel]))?.providerId, wayIds.funnel);
});

test("a lasting way blocked on an administrator step falls back to the temporary address", () => {
  const blocks = { [wayIds.funnel]: { text: "blocked" } };
  assert.equal(recommendedWay(fresh, caps, blocks, new Set([wayIds.funnel]))?.providerId, wayIds.temporary);
});

test("without Tailscale installed the temporary address is recommended", () => {
  assert.equal(recommendedWay(withTailscale("missing"), caps, {}, new Set([wayIds.funnel]))?.providerId, wayIds.temporary);
});

test("every way is grouped by reach and lifetime, and the title and line are the catalog's", () => {
  const groups = otherWays(fresh, caps, wayIds.temporary);
  const placed = Object.fromEntries(groups.flatMap((group) => group.rows.map((row) => [row.providerId, group.id])));
  assert.deepEqual(placed, {
    [wayIds.funnel]: "lasting",
    [wayIds.ngrok]: "lasting",
    [wayIds.cloudflare]: "lasting",
    [wayIds.tailnet]: "own-devices",
    [wayIds.lan]: "own-devices",
    [wayIds.ownAddress]: "advanced",
    [wayIds.tunnl]: "advanced",
    [wayIds.ngrokTls]: "advanced",
    [wayIds.ngrokTcp]: "advanced",
  });
  const rows = Object.fromEntries(groups.flatMap((group) => group.rows.map((row) => [row.providerId, row])));
  assert.equal(rows[wayIds.funnel]!.title, "Tailscale Funnel");
  assert.match(rows[wayIds.funnel]!.line, /^Free on the Personal plan/);
  assert.equal(rows[wayIds.lan]!.title, "Local network");
  assert.equal(rows[wayIds.tunnl]!.title, "tunnl.gg trial");
});

test("within a group, ways this computer can run come first", () => {
  const lasting = otherWays(fresh, caps, wayIds.temporary).find((group) => group.id === "lasting")!;
  assert.deepEqual(lasting.rows.map((row) => [row.providerId, row.usable]), [
    [wayIds.funnel, true],
    [wayIds.ngrok, false],
    [wayIds.cloudflare, false],
  ]);
});
