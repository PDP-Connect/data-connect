// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The compiled Slack profiles (data-connectors 97536ad49 = 0.6.0, 861be44d48 = 0.7.1) run through
 * the real controller as the developer-local source `slack`, offline, against a legacy-upgraded
 * registration. See helpers/legacy-profile-slack.ts for what is real and what is replaced.
 */

import test from "node:test";
import {
	assertCompiledSlackOffline,
	assertCompiledSlackUpgrade,
} from "./helpers/legacy-profile-slack-scenario.ts";
import { sqliteBackend } from "./helpers/legacy-upgrade.ts";

test(
	"compiled slack 0.6.0 -> 0.7.1 local sources: streams, state, fetched_at and grant reads across the upgrade",
	{
		timeout: 240_000,
	},
	() => assertCompiledSlackUpgrade(sqliteBackend),
);

test(
	"compiled slack 0.7.1 with the network closed: archive streams run, Web API streams are skipped",
	{
		timeout: 120_000,
	},
	() => assertCompiledSlackOffline(sqliteBackend),
);
