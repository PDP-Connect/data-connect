// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import { serverAddressHeadline } from "./server-checks.tsx";
import { referenceOriginRow } from "../components/deployment-readiness-rows.ts";
import type { ServerInputs } from "../components/deployment-readiness-rows.ts";

const inputs: ServerInputs = {
  databasePath: "/data/pdpp.db",
  diskHeadroom: [],
  embeddingBackendAvailable: true,
  embeddingBackendConfigured: true,
  embeddingDownloadAllowed: true,
  embeddingModelCachePresent: true,
  ownerPasswordProvenance: "redacted",
  referenceOriginConfigured: "https://example.com",
  vectorIndexKind: "sqlite-vec",
  vectorIndexState: "built",
};

test("the headline says reachable when the address check passes", () => {
  const row = referenceOriginRow(inputs, "https://example.com");
  assert.equal(serverAddressHeadline(row), "The server is reachable.");
});

test("the headline says blocked when the address check fails", () => {
  const row = referenceOriginRow(inputs, "https://other.example.com");
  assert.equal(serverAddressHeadline(row), "The server address is blocked.");
});

test("the headline says unknown while the address result is unknown", () => {
  const row = referenceOriginRow(inputs, null);
  assert.equal(serverAddressHeadline(row), "The server address is unknown.");
});
