// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import { formatConnectionDisplayName } from "@pdpp/display";
import { NO_NAME_FALLBACK } from "../../../lib/connection-display-name.ts";
import { setupStatusName } from "./setup-status-name.ts";

const venmo = { connection_id: "cin_1", connector_id: "venmo", display_name: "venmo" };
const sources = async () => [{ connectionId: "cin_1", displayName: "Venmo" }];

test("the fallback phrase matches what @pdpp/display returns for an unnamed connection", () => {
  assert.equal(formatConnectionDisplayName(null, null, null), NO_NAME_FALLBACK);
});

test("with no manifest, a connection saved under its key takes the service's name from the sources read", async () => {
  assert.equal(await setupStatusName(venmo, undefined, sources), "Venmo");
});

test("a manifest name or a saved name is used without asking the sources read", async () => {
  const never = async () => { throw new Error("must not be read"); };
  assert.equal(await setupStatusName(venmo, "Venmo", never), "Venmo");
  assert.equal(await setupStatusName({ ...venmo, display_name: "Work Venmo" }, undefined, never), "Work Venmo");
});

test("when the sources read fails or lacks the connection, the fallback phrase stays", async () => {
  assert.equal(await setupStatusName(venmo, undefined, async () => { throw new Error("down"); }), NO_NAME_FALLBACK);
  assert.equal(await setupStatusName(venmo, undefined, async () => []), NO_NAME_FALLBACK);
});
