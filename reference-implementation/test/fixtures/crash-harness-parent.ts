// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Parent for test/crash-harness.test.ts: starts crash-harness-child.ts, writes
// the child's pid to a file once the child is parked ("parked") or running
// with no armed point ("running"), then parks itself so the test can SIGKILL it.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { crashPoint } from "../../server/crash-point.ts";
import { armCrashPoints, spawnCrashChild } from "../helpers/crash-harness.ts";

armCrashPoints();
const [log, pidFile, mode] = process.argv.slice(2) as [
	string,
	string,
	"parked" | "running",
];
const child = spawnCrashChild(
	join(import.meta.dirname, "crash-harness-child.ts"),
	{
		args: [log, "linger"],
		points: mode === "parked" ? ["after-one"] : [],
	},
);
if (mode === "parked") {
	await child.parked("after-one");
} else {
	while (!(existsSync(log) && readFileSync(log, "utf8").includes("three"))) {
		await new Promise((settle) => setTimeout(settle, 20));
	}
}
writeFileSync(pidFile, String(child.pid));
crashPoint("child-started");
