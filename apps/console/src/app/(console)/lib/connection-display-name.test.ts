// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import { connectionDisplayName } from "./connection-display-name.ts";

test("connection names prefer an owner label, then the connector display name, then a generic name", () => {
  assert.equal(connectionDisplayName("My Spotify", "Spotify", "spotify"), "My Spotify");
  assert.equal(connectionDisplayName(null, "Spotify", "spotify"), "Spotify");
  assert.equal(connectionDisplayName(null, null, "spotify"), "this data source");
});

test("a saved name equal to the connector key in any case is not a name", () => {
  assert.equal(connectionDisplayName("spotify", "Spotify", "spotify"), "Spotify");
  assert.equal(connectionDisplayName(" SPOTIFY ", "Spotify", "spotify"), "Spotify");
  assert.equal(connectionDisplayName(" SPOTIFY ", "sPoTiFy", "spotify"), "sPoTiFy");
});
