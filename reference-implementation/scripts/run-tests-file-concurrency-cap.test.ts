// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const runTestsSource = readFileSync(
	new URL("./run-tests.ts", import.meta.url),
	"utf8",
);

test("PostgreSQL profile keeps the default file concurrency cap at two", () => {
	assert.match(
		runTestsSource,
		/const DEFAULT_FILE_CONCURRENCY_CAP = selectedProfile === "postgres" \? 2 : 8;/,
		"the runner must cap PostgreSQL at two by default while allowing memory-default to use eight",
	);
});

test("explicit PDPP_TEST_CONCURRENCY still overrides the profile default", () => {
	assert.match(
		runTestsSource,
		/Number\.isInteger\(requestedConcurrency\) && requestedConcurrency > 0 \? requestedConcurrency : defaultConcurrency;/,
		"an explicit positive PDPP_TEST_CONCURRENCY must remain authoritative for either profile",
	);
});
