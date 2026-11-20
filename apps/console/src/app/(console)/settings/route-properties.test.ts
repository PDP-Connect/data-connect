// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
// The Turn on card's cost and reader lines come from the library's structured
// properties, and "no account" appears only when the library says so.
import assert from "node:assert/strict";
import test from "node:test";
import { type Candidate, formatDisclosures, payloadReadingLine } from "./prepare-remote-access.ts";

function candidate(needsAccount: boolean | null | "absent", cost: unknown = { kind: "free", summary: "prose" }): Candidate {
  return {
    providerId: "localhost-run",
    display: { label: "localhost.run trial" },
    ...(needsAccount === "absent" ? {} : { properties: { cost: { kind: "free" }, needsAccount, traffic: { providerCanReadPayload: true } } }),
    consent: { disclosures: { traffic: { providerCanReadPayload: true }, cost } },
  } as unknown as Candidate;
}
const deal = (value: Candidate) => formatDisclosures(value).lines.filter((line) => line.kind === "deal").map((line) => line.text);

test("the reader sentence follows the library's true, false and unknown", () => {
  assert.equal(payloadReadingLine("localhost.run", true), "localhost.run can see what passes through.");
  assert.equal(payloadReadingLine("Tailscale Funnel", false), "Tailscale Funnel can't read what passes through.");
  assert.equal(payloadReadingLine("ngrok", null), "We can't tell whether ngrok can read what passes through.");
});

test("a free way says 'no account' only when the library says it needs none", () => {
  assert.ok(deal(candidate(false)).includes("Free, no account."), deal(candidate(false)).join("|"));
  assert.ok(deal(candidate(true)).includes("Free."));
  assert.ok(deal(candidate(null)).includes("Free."));
  assert.ok(deal(candidate("absent")).includes("Free."));
});

test("'no account' is never added to a way that is not free", () => {
  const paid = candidate(false, { kind: "paid", summary: "p", amount: 5, currency: "USD", period: "month" });
  assert.ok(!deal(paid).some((text) => /no account/.test(text)), deal(paid).join("|"));
});
