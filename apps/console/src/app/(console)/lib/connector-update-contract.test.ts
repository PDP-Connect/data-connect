// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import { parseConnectorUpdateConsentToken, parseConnectorUpdatePlan } from "./connector-update-contract.ts";

const digest = `sha256:${"a".repeat(64)}`;

test("Update all count comes from the server plan, including items outside a filtered catalog", () => {
  const plan = parseConnectorUpdatePlan({
    data: {
      items: [
        {
          connector_id: "github",
          installed: { digest, version: "1.0.0" },
          target: { digest, version: "1.1.0" },
          manual_eligible: true,
          review_required: false,
          reasons: [],
        },
        {
          connector_id: "reddit",
          installed: { digest, version: "1.0.0" },
          target: { digest, version: "2.0.0" },
          manual_eligible: false,
          review_required: true,
          reasons: ["major_version"],
        },
      ],
      manual_count: 1,
      plan_id: "plan-1",
      review_count: 1,
      state: "ready",
    },
  });
  assert.equal(plan.manual_count, 1);
  assert.equal(plan.review_count, 1);
  assert.equal(plan.items[1]?.review_required, true);
});

test("consent token parses bare or inside the data envelope", () => {
  assert.equal(parseConnectorUpdateConsentToken({ consent_token: "c1" }), "c1");
  assert.equal(parseConnectorUpdateConsentToken({ data: { consent_token: "c2" } }), "c2");
  assert.throws(() => parseConnectorUpdateConsentToken({}));
});
