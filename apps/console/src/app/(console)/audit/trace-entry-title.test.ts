// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { test } from "node:test";
import { traceEntryTitle } from "./trace-entry-title.ts";

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
