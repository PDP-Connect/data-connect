// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import { resolveReferenceMode, resolveReferenceTopology } from "./reference-topology.ts";

test("unsupported explicit topology modes fail before public hints are considered", () => {
  for (const hints of [{}, { asPublicUrl: "https://reference.example.test" }]) {
    assert.throws(() => resolveReferenceTopology({
      explicitMode: "compsoed",
      env: {},
      ...hints,
    }), /explicit reference mode/i);
  }
});

test("unsupported ambient topology modes fail only when that source is consulted", () => {
  const env = { PDPP_REFERENCE_MODE: "compsoed", AS_PUBLIC_URL: "https://reference.example.test" };
  assert.throws(() => resolveReferenceMode({ env }), /PDPP_REFERENCE_MODE/);
  assert.equal(resolveReferenceMode({ env, ignoreAmbient: true }), "direct");
  assert.equal(resolveReferenceMode({ env, explicitMode: " DIRECT " }), "direct");
  assert.equal(resolveReferenceMode({ env, asPublicUrl: "https://reference.example.test" }), "composed");
});

test("blank and missing modes keep the existing inference and defaults", () => {
  assert.equal(resolveReferenceMode({ env: {} }), "direct");
  assert.equal(resolveReferenceMode({ explicitMode: "  ", env: { PDPP_REFERENCE_MODE: " " } }), "direct");
  assert.equal(resolveReferenceMode({
    explicitMode: " ",
    env: { PDPP_REFERENCE_MODE: " ", AS_PUBLIC_URL: "https://reference.example.test" },
  }), "composed");
  assert.equal(resolveReferenceMode({ env: { PDPP_REFERENCE_MODE: " CoMpOsEd " } }), "composed");
});
