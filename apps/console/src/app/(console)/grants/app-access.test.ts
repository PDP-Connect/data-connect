// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import type { GrantSummary } from "../lib/ref-client.ts";
import { activePackageAccesses, appSourceName, formatAppLastRead, groupGrantAccessByApp, pendingApprovalAppName, splitAppAccessGroups } from "./app-access.ts";

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

test("app rows list only data sources with active access", () => {
  // apps-repair.md P2: after one child is removed, show only the remaining live access.
  const rows = groupGrantAccessByApp([
    grant(),
    grant({ grant_id: "removed", status: "revoked", source: { id: "spotify", kind: "connector" } }),
  ]);
  assert.deepEqual(rows[0]?.sources, ["Gmail"]);

  const removedRows = groupGrantAccessByApp([grant({ status: "revoked" })]);
  assert.deepEqual(removedRows[0]?.sources, []);
});

test("removed app history keeps the known name and removal time", () => {
  const clientId = "https://chat.example/id";
  const rows = groupGrantAccessByApp([
    grant({
      client: undefined,
      client_id: clientId,
      grant_id: "removed",
      last_at: "2026-11-25T12:30:00.000Z",
      status: "revoked",
    }),
    grant({
      client: { client_id: clientId, client_name: "Listening recap", registration_mode: null },
      client_id: clientId,
      status: "revoked",
    }),
  ]);

  // round5 item 2: history rows use the shared app name and the stopped grant's last event time.
  assert.equal(rows[0]?.name, "Listening recap");
  assert.equal(rows[0]?.stoppedAt, "2026-11-25T12:30:00.000Z");
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
  // DIRECTION.md, Home § Apps that can read your data: source names remain plain and readable.
  assert.equal(appSourceName({ id: "spotify", kind: "connector" }), "Spotify");
  // PAGE-RULES 6: connector names use the shared display rule.
  assert.equal(appSourceName({ id: "github", kind: "connector" }), "GitHub");
  // DIRECTION.md, Home § Apps that can read your data: built-in sources use their display name.
  assert.equal(appSourceName({ id: "health", kind: "provider_native" }), "Health");
});

test("access groups separate apps with current access from stopped access", () => {
  const apps = groupGrantAccessByApp([
    grant(),
    grant({ client_id: "old", client: { client_id: "old", client_name: "Travel notes", registration_mode: null }, grant_id: "stopped", status: "revoked" }),
  ]);
  const groups = splitAppAccessGroups(apps);
  // Round 6 item 3: only current access belongs under "Apps that can read your data".
  assert.deepEqual(groups.reading.map((app) => app.name), ["Chat helper"]);
  // Round 6 item 3: revoked access belongs under the separate stopped group.
  assert.deepEqual(groups.stopped.map((app) => app.name), ["Travel notes"]);
});

test("package access lists use the server's active child and membership states", () => {
  // apps-repair.md P2: show zero after the last removal and the remaining count when access remains.
  assert.deepEqual(activePackageAccesses([
    { grant_status: "revoked", member_status: "active" },
  ]), []);
  const remaining = { grant_status: "active", member_status: "active", grant_id: "remaining" };
  assert.deepEqual(activePackageAccesses([
    { grant_status: "revoked", member_status: "active" },
    remaining,
    { grant_status: "active", member_status: "revoked" },
  ]), [remaining]);
});

test("waiting request names use a known app name, else the plain fallback", () => {
  // apps-repair.md P2: the app's name when known; "An app" when the server gives nothing.
  assert.equal(pendingApprovalAppName("Chat helper"), "Chat helper");
  assert.equal(pendingApprovalAppName("  "), "An app");
  assert.equal(pendingApprovalAppName(null), "An app");
});

test("waiting request titles never fall back to the request address host", async () => {
  // Deputy repair: a Connect-an-app identity's client_id is on this server's own
  // host, and a host can be shaped like a trusted name; neither is the app's name.
  const src = await readFile(new URL("./page.tsx", import.meta.url), "utf8");
  assert.match(src, /appName=\{pendingApprovalAppName\(clientNames\.get\(approval\.client_id \?\? ""\)\)\}/);
  const helper = await readFile(new URL("./app-access.ts", import.meta.url), "utf8");
  const start = helper.indexOf("export function pendingApprovalAppName");
  const body = helper.slice(start, helper.indexOf("\n}\n", start));
  assert.ok(start >= 0 && body.length > 0);
  assert.doesNotMatch(body, /new URL\(|hostname|client_?[iI]d/);
});
