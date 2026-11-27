// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import test from "node:test";
import { oneSyncKindNames } from "./one-sync-model.ts";

test("the sync's page names every kind it prints, including the ones held now, like the data source's page", () => {
	const sources = [{ id: "gmail-a", connector: "gmail", name: "Gmail", kinds: [{ name: "threads", display: { label: "Your conversations" } }, { name: "message_bodies", display: { label: "The text of your emails" } }] }];
	const names = oneSyncKindNames(sources, "gmail-a", ["threads", "message_bodies"]);
	assert.deepEqual(names, { threads: "Your conversations", message_bodies: "The text of your emails" });
});
