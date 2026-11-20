// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
// The service name the owner reads: the console's own name for a trial plan's
// provider, the library's label for every other way.
import assert from "node:assert/strict";
import test from "node:test";
import { type Candidate, formatDisclosures } from "./prepare-remote-access.ts";
import { serviceName } from "./service-name.ts";

test("a trial plan's provider reads as the service, other ways keep the library's label", () => {
  assert.equal(serviceName("localhost-run", "localhost.run trial"), "localhost.run");
  assert.equal(serviceName("tunnl-gg", "tunnl.gg trial"), "tunnl.gg");
  assert.equal(serviceName("ngrok-https-edge", "ngrok HTTPS edge"), "ngrok HTTPS edge");
  assert.equal(serviceName(null, "Some tunnel"), "Some tunnel");
});

test("the Turn on card's reading line names localhost.run, not 'localhost.run trial'", () => {
  const candidate = {
    providerId: "localhost-run",
    display: { label: "localhost.run trial" },
    consent: { disclosures: { traffic: { providerCanReadPayload: true } } },
  } as unknown as Candidate;
  const texts = formatDisclosures(candidate).lines.map((line) => line.text);
  assert.ok(texts.includes("localhost.run can see what passes through."), texts.join("|"));
  assert.ok(!texts.some((text) => text.includes("trial")), texts.join("|"));
});
