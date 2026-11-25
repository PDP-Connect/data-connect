// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { test } from "node:test";
import type { SpineEvent } from "../lib/ref-client.ts";
import { traceEntryReadFacts, traceEntryTitle } from "./trace-entry-title.ts";

test("an app's read titles the entry as an app read, also when the server records the owner as actor", () => {
  // Seen on a live instance: owner-session reads through the console carry actor_type "subject" and a client_id.
  assert.deepEqual(traceEntryTitle({ actor_type: "subject", client_id: "dataconnect-console", event_type: "query.received" }), {
    actor: "An app",
    kind: "Data read",
    title: "An app read your data",
  });
  assert.equal(
    traceEntryTitle({ actor_type: "client", client_id: null, event_type: "disclosure.served" }).title,
    "An app read your data"
  );
});

test("a device entry names the device", () => {
  assert.equal(
    traceEntryTitle({ actor_type: "device", client_id: null, event_type: "pdpp.subscription.verify" }).title,
    "A device: device login"
  );
});

test("RAISE-RULES 2: with no actor the title says what happened and never reads 'Activity read your data'", () => {
  const read = traceEntryTitle({ actor_type: "runtime", client_id: null, event_type: "disclosure.served" });
  assert.equal(read.actor, null);
  assert.equal(read.title, "Your data was read");
  assert.equal(traceEntryTitle({ actor_type: "authorization_server", client_id: null, event_type: "grant.issued" }).title, "Access granted");
  assert.equal(traceEntryTitle(null).title, "Activity");
});

test("read facts name the source, kind, and count only when each is present", () => {
  const full = {
    actor_id: "client-1",
    actor_type: "client",
    client_id: "client-1",
    data: { query_shape: "record_list", record_count: 120, source: { id: "spotify", kind: "connector" } },
    event_id: "event-1",
    event_type: "disclosure.served",
    stream_id: "top_artists",
  } as unknown as SpineEvent;
  assert.equal(traceEntryReadFacts([full], true), "120 Spotify top artists");

  // Missing source: the kind and count stay, no data source is named.
  const noSource = { ...full, data: { record_count: 7 } } as SpineEvent;
  assert.equal(traceEntryReadFacts([noSource], true), "7 top artists");

  const partial = { ...full, data: { record_count: 4 }, stream_id: null } as SpineEvent;
  assert.equal(traceEntryReadFacts([partial], true), "4 records");
  assert.equal(traceEntryTitle(full, traceEntryReadFacts([full], true)).title, "An app read 120 Spotify top artists");
  assert.equal(
    traceEntryTitle({ ...full, actor_type: "runtime", client_id: null }, traceEntryReadFacts([full], true)).title,
    "Read 120 Spotify top artists"
  );
});

test("read facts never name a kind as read when the event served no records", () => {
  // Seen on a live instance: a kind's description read (stream_metadata) carries a source and a
  // kind but no record_count; "An app read Reddit Comments" would claim records were read.
  const metadataOnly = {
    actor_type: "subject",
    client_id: "dataconnect-console",
    data: { query_shape: "stream_metadata", relationship_count: 0, source: { id: "reddit", kind: "connector" }, view_count: 2 },
    event_type: "disclosure.served",
    stream_id: "comments",
  } as unknown as SpineEvent;
  assert.equal(traceEntryReadFacts([metadataOnly], true), null);
  assert.equal(traceEntryTitle(metadataOnly, traceEntryReadFacts([metadataOnly], true)).title, "An app read your data");
});

test("read facts speak for the whole entry only when they can", () => {
  const read = {
    actor_type: "client",
    client_id: "client-1",
    data: { record_count: 3, source: { id: "spotify", kind: "connector" } },
    event_type: "disclosure.served",
    stream_id: "top_artists",
  } as unknown as SpineEvent;
  // Two reads in one entry: one read's count is not the entry's count.
  assert.equal(traceEntryReadFacts([read, { ...read, stream_id: "saved_tracks" }], true), null);
  // More events on a later page: the loaded read may not be the only one.
  assert.equal(traceEntryReadFacts([read], false), null);
});
