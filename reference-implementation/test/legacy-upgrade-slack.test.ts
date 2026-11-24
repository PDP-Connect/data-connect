// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import test from "node:test";

import { sqliteBackend } from "./helpers/legacy-upgrade.ts";
import { assertSlackPathPreservesOwnerData } from "./helpers/legacy-upgrade-slack.ts";

test("registering slack 0.7.1 over a c82718d4 slack 0.6.0 registration keeps ids, streams, state, old records and grant rows", async () => {
  await assertSlackPathPreservesOwnerData(sqliteBackend);
});
