// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { test } from "node:test";
import { dashboardRoutes, sandboxRoutes } from "@pdpp/operator-ui/components/views/routes";

// Explore brief decision 5: the whole row peeks on desktop and opens the record on a phone.
const MOBILE_ROW_LINK_RE = /className=\{`\$\{rowClassName\} rr-x-row--mobile`\}[\s\S]{0,80}href=\{detailHref\}/;
const DESKTOP_ROW_PEEK_BUTTON_RE = /className=\{`\$\{rowClassName\} rr-x-row--desktop`\}[\s\S]{0,240}onClick=\{onSelect\}/;
// The forbidden meta re-render of the secondary (= rowSecondary, which the shared
// RecordIdentity cell already shows). Its presence = the double-rendered secondary bug.
const META_SECONDARY_SNIPPET_RE = /rr-x-row__snippet-text">\{snippet\}/;

// The view renders <Link href={routes.record(entry.connectionId ?? entry.connectorId, …)}>.
// `resolveConnectionForRecordsRoute` accepts either a connection_id (preferred)
// or a connector_id (falls back to the FIRST matching connection). To avoid
// the route-level guess when we know the concrete connection, the row link
// MUST pass the connection_id segment.

test("row link uses the concrete connection_id when known", () => {
  const entry: { connectionId: string | null; connectorId: string } = {
    connectionId: "conn-work",
    connectorId: "gmail",
  };
  const href = dashboardRoutes.record(entry.connectionId ?? entry.connectorId, "messages", "rec-1");
  assert.equal(href, "/sources/conn-work/messages/rec-1");
});

test("row link falls back to connector_id when connection identity is genuinely unknown", () => {
  const entry: { connectionId: string | null; connectorId: string } = {
    connectionId: null,
    connectorId: "gmail",
  };
  const href = dashboardRoutes.record(entry.connectionId ?? entry.connectorId, "messages", "rec-1");
  assert.equal(href, "/sources/gmail/messages/rec-1");
});

test("row link routes two same-connector connections to distinct paths", () => {
  // Regression: prior code passed `entry.connectorId` directly, sending two
  // distinct Gmail connections through the same `/sources/gmail`
  // path, where `resolveConnectionForRecordsRoute` picks the first match.
  const personalEntry: { connectionId: string | null; connectorId: string } = {
    connectionId: "conn-personal",
    connectorId: "gmail",
  };
  const workEntry: { connectionId: string | null; connectorId: string } = {
    connectionId: "conn-work",
    connectorId: "gmail",
  };
  const personal = dashboardRoutes.record(personalEntry.connectionId ?? personalEntry.connectorId, "messages", "rec-1");
  const work = dashboardRoutes.record(workEntry.connectionId ?? workEntry.connectorId, "messages", "rec-1");
  assert.notEqual(personal, work);
  assert.equal(personal, "/sources/conn-personal/messages/rec-1");
  assert.equal(work, "/sources/conn-work/messages/rec-1");
});

test("route-map binding keeps live sources and legacy sandbox records distinct", () => {
  const subject = {
    connectionId: "conn-work/account",
    connectorId: "gmail",
    recordId: "rec/1#two",
    stream: "messages/threads",
  };

  assert.equal(
    dashboardRoutes.record(subject.connectionId, subject.stream, subject.recordId),
    "/sources/conn-work%2Faccount/messages%2Fthreads/rec%2F1%23two"
  );
  assert.equal(
    sandboxRoutes.record(subject.connectionId, subject.stream, subject.recordId),
    "/sandbox/records/conn-work%2Faccount/messages%2Fthreads/rec%2F1%23two"
  );
});

// Explore brief decision 5: desktop rows open the inspector; phone rows open the full record.
test("LIVE FeedRow: mobile tap routes to the full record detail (R4)", async () => {
  const { readFileSync } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  const path = await import("node:path");
  const here = path.dirname(fileURLToPath(import.meta.url));
  const canvasPath = path.join(here, "explore-canvas.tsx");
  const src = readFileSync(canvasPath, "utf8");
  assert.match(src, MOBILE_ROW_LINK_RE, "mobile row Link must navigate to the full record route via detailHref (R4)");
});

test("LIVE FeedRow: desktop row body peeks; a separate Open routes to the full record (distinct #12)", async () => {
  const { readFileSync } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  const path = await import("node:path");
  const here = path.dirname(fileURLToPath(import.meta.url));
  const canvasPath = path.join(here, "explore-canvas.tsx");
  const src = readFileSync(canvasPath, "utf8");
  assert.match(
    src,
    DESKTOP_ROW_PEEK_BUTTON_RE,
    "desktop row body (button) must open the in-place peek via onClick={onSelect}"
  );
  assert.ok(src.includes('onClick={onSelect}'), "the whole desktop row must open the inspector");
});

// Explore brief decision 5: each row has one title, one kind/source line, and one time.
test("LIVE FeedRow: shows a single kind/source context line without a match excerpt", async () => {
  const { readFileSync } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  const path = await import("node:path");
  const here = path.dirname(fileURLToPath(import.meta.url));
  const src = readFileSync(path.join(here, "explore-canvas.tsx"), "utf8");
  assert.ok(src.includes("rr-x-row__meta"), "the row must render its kind and data source line");
  assert.doesNotMatch(src, META_SECONDARY_SNIPPET_RE, "the row must not render a second context snippet");
  assert.ok(!src.includes("matchExcerpt"), "the row should not add a search excerpt as a second context line");
});
