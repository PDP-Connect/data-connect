// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import type { GrantSummary } from "../lib/ref-client.ts";
import { appSourceName, formatAppLastRead, groupGrantAccessByApp } from "./app-access.ts";

function grant(overrides: Partial<GrantSummary> = {}): GrantSummary {
  return {
    client: { client_id: "https://chat.example/id", client_name: "Chat helper", registration_mode: null },
    client_id: "https://chat.example/id",
    connector_id: "gmail",
    event_count: 1,
    failure: null,
    first_at: "2026-11-24T12:00:00.000Z",
    grant_id: "access-1",
    kinds: ["messages"],
    last_at: "2026-11-25T12:00:00.000Z",
    object: "grant_summary",
    source: { id: "gmail", kind: "connector" },
    status: "issued",
    ...overrides,
  };
}

test("access rows group by app and keep source names and the latest read", () => {
  const rows = groupGrantAccessByApp([
    grant(),
    grant({
      connector_id: "spotify",
      grant_id: "access-2",
      last_at: "2026-11-25T13:00:00.000Z",
      source: { id: "spotify", kind: "connector" },
    }),
  ]);

  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.name, "Chat helper");
  assert.deepEqual(rows[0]?.sources, ["Gmail", "Spotify"]);
  assert.equal(rows[0]?.lastRead, "2026-11-25T13:00:00.000Z");
  assert.equal(rows[0]?.grantIds.length, 2);
  assert.equal(rows[0]?.status, null);
});

test("access inside a package is removed as the package, loose access one by one", () => {
  const rows = groupGrantAccessByApp([
    grant({ grant_id: "access-1", grant_package_id: "pkg-1" }),
    grant({ grant_id: "access-2", grant_package_id: "pkg-1" }),
    grant({ grant_id: "access-3" }),
    grant({ grant_id: "access-4", grant_package_id: "pkg-2", status: "revoked" }),
  ]);
  assert.deepEqual(rows[0]?.packageIds, ["pkg-1"]);
  assert.deepEqual(rows[0]?.grantIds, ["access-3"]);
});

test("only inactive access gets a plain status word", () => {
  assert.equal(groupGrantAccessByApp([grant({ status: "revoked" })])[0]?.status, "Removed");
  assert.equal(groupGrantAccessByApp([grant({ status: "denied" })])[0]?.status, "Not allowed");
  assert.equal(groupGrantAccessByApp([grant({ status: "failed" })])[0]?.status, "Failed");
  assert.equal(groupGrantAccessByApp([grant({ status: "issued" })])[0]?.status, null);
});

test("relative read times use words and handle missing data", () => {
  const now = Date.parse("2026-11-25T13:00:00.000Z");
  assert.equal(formatAppLastRead("2026-11-25T12:00:00.000Z", now), "1 hour ago");
  assert.equal(formatAppLastRead(null, now), "No reads yet");
});

test("source names read as names, including provider-native sources", () => {
  assert.equal(appSourceName({ id: "spotify", kind: "connector" }), "Spotify");
  assert.equal(appSourceName({ id: "health", kind: "provider_native" }), "Health");
});
