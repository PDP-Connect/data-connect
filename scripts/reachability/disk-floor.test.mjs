import assert from "node:assert/strict";
import test from "node:test";
import {
	LOCAL_DISK_FLOOR_ENV,
	LOCAL_DISK_REASON_ENV,
	RELEASE_DISK_FLOOR_BYTES,
	requireDiskFloor,
	resolveDiskFloor,
} from "./disk-floor.mjs";

test("default keeps the release floor", () => {
	assert.deepEqual(resolveDiskFloor({}), {
		floor: RELEASE_DISK_FLOOR_BYTES,
		waived: false,
	});
});
test("a waived floor needs a reason, a sane value and stays below release", () => {
	assert.throws(() => resolveDiskFloor({ [LOCAL_DISK_FLOOR_ENV]: "50000000000" }));
	assert.throws(() =>
		resolveDiskFloor({ [LOCAL_DISK_FLOOR_ENV]: "14999999999", [LOCAL_DISK_REASON_ENV]: "x" }),
	);
	assert.throws(() =>
		resolveDiskFloor({ [LOCAL_DISK_FLOOR_ENV]: "1", [LOCAL_DISK_REASON_ENV]: "x" }),
	);
	assert.throws(() =>
		resolveDiskFloor({
			[LOCAL_DISK_FLOOR_ENV]: String(RELEASE_DISK_FLOOR_BYTES),
			[LOCAL_DISK_REASON_ENV]: "x",
		}),
	);
	assert.equal(
		resolveDiskFloor({ [LOCAL_DISK_FLOOR_ENV]: "40000000000", [LOCAL_DISK_REASON_ENV]: "r" }).waived,
		true,
	);
});
test("a waived floor still refuses when real free bytes are below it", async () => {
	const quiet = process.stderr.write;
	process.stderr.write = () => true;
	try {
		await assert.rejects(
			requireDiskFloor({
				[LOCAL_DISK_FLOOR_ENV]: "104999999999",
				[LOCAL_DISK_REASON_ENV]: "r",
			}),
			{ code: "disk_floor" },
		);
	} finally {
		process.stderr.write = quiet;
	}
});
test("release and CI environments refuse the waiver", () => {
	for (const marker of ["CI", "GITHUB_ACTIONS", "RELEASE", "SEMANTIC_RELEASE"])
		assert.throws(
			() =>
				resolveDiskFloor({
					[marker]: "true",
					[LOCAL_DISK_FLOOR_ENV]: "15000000000",
					[LOCAL_DISK_REASON_ENV]: "r",
				}),
			/refused/,
		);
	assert.equal(
		resolveDiskFloor({ CI: "true" }).floor,
		RELEASE_DISK_FLOOR_BYTES,
	);
});
