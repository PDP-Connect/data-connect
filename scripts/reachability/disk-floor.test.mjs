// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import test from "node:test";
import fsPromises from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
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
for (const { name, env, floor, waived } of [
	{ name: "default", env: {}, floor: RELEASE_DISK_FLOOR_BYTES, waived: false },
	{
		name: "local waiver",
		env: { [LOCAL_DISK_FLOOR_ENV]: "15000000000", [LOCAL_DISK_REASON_ENV]: "local test" },
		floor: 15_000_000_000,
		waived: true,
	},
]) {
	test(`${name} checks measured bytes at the boundary without depending on host disk`, async (t) => {
		let available = floor - 1;
		const measurement = t.mock.method(fsPromises, "statfs", async () => ({
			bavail: available,
			bsize: 1,
		}));
		const lines = [];
		const output = t.mock.method(process.stderr, "write", (line) => {
			lines.push(String(line));
			return true;
		});
		syncBuiltinESMExports();
		try {
			await assert.rejects(requireDiskFloor(env), { code: "disk_floor" });
			available = floor;
			assert.deepEqual(await requireDiskFloor(env), { available, floor, waived });
			available = 2 * RELEASE_DISK_FLOOR_BYTES;
			assert.deepEqual(await requireDiskFloor(env), { available, floor, waived });
			assert.equal(measurement.mock.calls.length, 3);
			if (waived) {
				const records = lines.map((line) => JSON.parse(line));
				assert.deepEqual(records.map((row) => row.availableBytes), [
					floor - 1, floor, 2 * RELEASE_DISK_FLOOR_BYTES,
				]);
				for (const row of records) {
					assert.equal(row.status, "DISK_PREFLIGHT_WAIVED");
					assert.equal(row.waivedFloorBytes, floor);
					assert.equal(row.releaseFloorBytes, RELEASE_DISK_FLOOR_BYTES);
					assert.equal(row.reason, "local test");
				}
			} else {
				assert.deepEqual(lines, []);
			}
		} finally {
			measurement.mock.restore();
			syncBuiltinESMExports();
			output.mock.restore();
		}
	});
}
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


for (const waived of [true, false]) {
 test(`reserve is added after choosing the ${waived ? 'waived' : 'release'} floor`, async t => {
  const env = waived ? {[LOCAL_DISK_FLOOR_ENV]:'15000000000',[LOCAL_DISK_REASON_ENV]:'synthetic reserve test'} : {};
  const base = waived ? 15_000_000_000 : RELEASE_DISK_FLOOR_BYTES;
  const reserveBytes = 2_000_000_000, required = base + reserveBytes;
  let available = base + 1_000_000_000;
  const measurement = t.mock.method(fsPromises,'statfs',async()=>({bavail:available,bsize:1}));
  const lines = [], output = t.mock.method(process.stderr,'write',line=>{lines.push(String(line));return true;});
  syncBuiltinESMExports();
  try {
   await assert.rejects(requireDiskFloor(env,'/synthetic',RELEASE_DISK_FLOOR_BYTES,{reserveBytes}),
    {code:'disk_floor',requiredFreeBytes:required,availableBytes:available,message:`NOT RUN (disk): need ${Math.round(required/1e9)} GB free`});
   available=base+3_000_000_000;
   assert.deepEqual(await requireDiskFloor(env,'/synthetic',RELEASE_DISK_FLOOR_BYTES,{reserveBytes}),{available,floor:required,waived});
   if (waived) for (const row of lines.map(JSON.parse)) {
    assert.equal(row.waivedFloorBytes,base);assert.equal(row.reserveBytes,reserveBytes);
    assert.equal(row.requiredFreeBytes,required);assert.equal(row.releaseFloorBytes,RELEASE_DISK_FLOOR_BYTES);
   } else assert.deepEqual(lines,[]);
  } finally {measurement.mock.restore();syncBuiltinESMExports();output.mock.restore();}
 });
}
test('invalid or overflowing reserves are rejected before measuring disk', async t => {
 const measurement=t.mock.method(fsPromises,'statfs',async()=>({bavail:Number.MAX_SAFE_INTEGER,bsize:1}));
 syncBuiltinESMExports();
 try {
  for (const reserveBytes of [-1,0.5,NaN,Infinity,'2',Number.MAX_SAFE_INTEGER])
   await assert.rejects(requireDiskFloor({},'/synthetic',RELEASE_DISK_FLOOR_BYTES,{reserveBytes}),/reserve/);
  assert.equal(measurement.mock.calls.length,0);
 } finally {measurement.mock.restore();syncBuiltinESMExports();}
});
