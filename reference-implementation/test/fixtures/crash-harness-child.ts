// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Child for test/crash-harness.test.ts: appends three steps to a log file,
// passing a crash point after each one.
import { appendFileSync } from "node:fs";

import { crashPoint } from "../../server/crash-point.ts";
import { armCrashPoints } from "../helpers/crash-harness.ts";

armCrashPoints();
const log = process.argv[2] as string;
for (const step of ["one", "two", "three"]) {
	appendFileSync(log, `${step}\n`);
	crashPoint(`after-${step}`);
}
process.stdout.write("finished\n");
