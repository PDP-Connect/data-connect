// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import { cannotAddWhy } from "./connect-copy.ts";

test("each reason a sign-in service cannot be added says why in plain words and what to do instead", () => {
  const reasons = ["host_requirement_unmet", "not_implemented", "not_published", "catalog_unavailable", "artifact_invalid", "inspection_unavailable", "not_installed", "runnable", "not_browser_bound"] as const;
  for (const reason of reasons) {
    const why = cannotAddWhy("Venmo", reason);
    if (why.reason !== null) assert.match(why.reason, /Venmo|this computer|DataConnect/);
    assert.ok(why.instead.length > 10);
    assert.doesNotMatch(`${why.reason ?? ""} ${why.instead}`, /host|artifact|catalog|manifest|binding|requirement/i);
  }
  assert.equal(cannotAddWhy("Venmo", "host_requirement_unmet").reason, "This computer can't open the browser that Venmo needs for signing in.");
  // With no known reason the heading already says it; the page does not say it a second time.
  assert.match(cannotAddWhy("Venmo", null).reason ?? "", /couldn.t tell whether Venmo/);
  assert.match(cannotAddWhy("Venmo", "something_new").instead, /Try again/);
});
