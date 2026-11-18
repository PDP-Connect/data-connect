import { appendFileSync } from "node:fs";
import { statfs } from "node:fs/promises";

export const RELEASE_DISK_FLOOR_BYTES = 105_000_000_000;
// A local run may lower the floor only with an explicit byte value AND a
// reason. The real free bytes are always measured and logged, and the run
// still refuses below the lowered floor. Release runs set neither variable.
export const LOCAL_DISK_FLOOR_ENV = "PDPP_LOCAL_DISK_FLOOR_BYTES";
export const LOCAL_DISK_REASON_ENV = "PDPP_LOCAL_DISK_WAIVER_REASON";
export const LOCAL_DISK_LOG_ENV = "PDPP_LOCAL_DISK_WAIVER_LOG";
const HARD_MINIMUM_BYTES = 20_000_000_000;

export function resolveDiskFloor(env = process.env) {
	const raw = env[LOCAL_DISK_FLOOR_ENV];
	if (raw === undefined || raw === "")
		return { floor: RELEASE_DISK_FLOOR_BYTES, waived: false };
	const floor = Number(raw);
	const reason = env[LOCAL_DISK_REASON_ENV]?.trim();
	if (!Number.isSafeInteger(floor) || floor < HARD_MINIMUM_BYTES)
		throw new Error(
			`${LOCAL_DISK_FLOOR_ENV} must be an integer of at least ${HARD_MINIMUM_BYTES} bytes`,
		);
	if (floor >= RELEASE_DISK_FLOOR_BYTES)
		throw new Error(`${LOCAL_DISK_FLOOR_ENV} must be below the release floor`);
	if (!reason) throw new Error(`${LOCAL_DISK_REASON_ENV} is required with a waived floor`);
	return { floor, waived: true, reason };
}

export async function requireDiskFloor(env = process.env, cwd = process.cwd()) {
	const { floor, waived, reason } = resolveDiskFloor(env);
	const disk = await statfs(cwd);
	const available = disk.bavail * disk.bsize;
	if (waived) {
		const line = JSON.stringify({
			at: new Date().toISOString(),
			status: "DISK_PREFLIGHT_WAIVED",
			availableBytes: available,
			waivedFloorBytes: floor,
			releaseFloorBytes: RELEASE_DISK_FLOOR_BYTES,
			reason,
		});
		process.stderr.write(`${line}\n`);
		if (env[LOCAL_DISK_LOG_ENV]) appendFileSync(env[LOCAL_DISK_LOG_ENV], `${line}\n`);
	}
	if (available < floor)
		throw Object.assign(
			new Error(`NOT RUN (disk): need ${Math.round(floor / 1e9)} GB free`),
			{ code: "disk_floor" },
		);
	return { available, floor, waived };
}
