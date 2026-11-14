// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { once } from "node:events";
import { chmod, mkdir, mkdtemp, readFile, rm, statfs } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createGozar } from "@tnunamak/gozar";
import { FixtureSecretBackend } from "../../reference-implementation/test/fixtures/reachability/secret-backend.ts";
import { createPreparedFixture } from "./prepared-fixture.mjs";

// Every usage is exercised, including explicit contract failures.
for (const usage of ["attached", "session", "durable"]) {
	test(`${usage}: crash after reservation/allocation before host handle persistence recovers through public enumeration`, {
		timeout: 60000,
	}, async () => {
		const disk = await statfs(process.cwd());
		if (disk.bavail * disk.bsize < 105_000_000_000)
			throw new Error("NOT RUN (disk): need 105 GB free");
		const parent = join(homedir(), ".tmp", "ra");
		await mkdir(parent, { recursive: true, mode: 0o700 });
		const root = await mkdtemp(join(parent, "crash-"));
		const child = fork(
			new URL("./recovery-crash-child.mjs", import.meta.url),
			[root, usage],
			{ stdio: ["ignore", "pipe", "pipe", "ipc"] },
		);
		let gozar, descriptor;
		try {
			const [message] = await Promise.race([
				once(child, "message"),
				once(child, "exit").then(() => {
					throw new Error("Crash fixture exited before allocation");
				}),
			]);
			assert.equal(message.stage, "allocated-before-host-handle-write");
			const intent = JSON.parse(
				await readFile(
					join(root, "host-operations", `${message.operationId}.json`),
					"utf8",
				),
			);
			assert.equal(intent.handle, null);
			assert.equal(intent.intent.providerId.length > 0, true);
			child.kill("SIGKILL");
			await once(child, "exit");
			descriptor = JSON.parse(
				await readFile(join(root, "recovery-descriptor.json"), "utf8"),
			);
			gozar = createGozar({
				manifest: descriptor.manifest,
				root: descriptor.root,
				identity: descriptor.identity,
				hostCapabilities: descriptor.hostCapabilities,
				secretBackend: new FixtureSecretBackend(),
			});
			const listed = await gozar.listRoutes({
				home: descriptor.home,
				owner: descriptor.owner,
			});
			const recovered = listed.routes.filter(
				(route) => route.operationId === message.operationId,
			);
			assert.equal(recovered.length, 1);
			const closed = await gozar.closeRoute({
				home: descriptor.home,
				handle: recovered[0].handle,
				mode: "remove",
			});
			assert.equal(closed.cleanup.state, "confirmed");
		} finally {
			if (child.exitCode === null && child.signalCode === null) {
				child.kill("SIGKILL");
				await once(child, "exit");
			}
			let clean = Boolean(gozar);
			if (gozar)
				for (const route of (
					await gozar.listRoutes({
						home: descriptor.home,
						owner: descriptor.owner,
					})
				).routes) {
					const result = await gozar.closeRoute({
						home: descriptor.home,
						handle: route.handle,
						mode: "remove",
					});
					clean &&= result.cleanup.state === "confirmed";
				}
			if (clean) await rm(root, { recursive: true, force: true });
		}
	});

	test(`${usage}: concurrent same-key replay returns one handle and one provider start`, {
		timeout: 60000,
	}, async () => {
		const fixture = await createPreparedFixture(undefined, { usage });
		try {
			const [first, duplicate] = await Promise.all([
				fixture.start(),
				fixture.start(),
			]);
			assert.deepEqual(first.handle, duplicate.handle);
			assert.equal(await fixture.startCount(), 1);
		} finally {
			await fixture.close();
		}
	});
	test(`${usage}: conflicting operation scope is refused with zero additional provider effects`, {
		timeout: 60000,
	}, async () => {
		const fixture = await createPreparedFixture(undefined, { usage });
		try {
			await fixture.start();
			const starts = await fixture.startCount();
			await assert.rejects(
				fixture.start({
					...fixture.request,
					target: fixture.request.target.replace(/:\d+$/, ":1"),
				}),
				{ code: "operation_conflict" },
			);
			assert.equal(await fixture.startCount(), starts);
		} finally {
			await fixture.close();
		}
	});
	test(`${usage}: a stopped operation key never restarts forwarding`, {
		timeout: 60000,
	}, async () => {
		const fixture = await createPreparedFixture(undefined, { usage });
		try {
			const route = await fixture.start();
			const closed = await fixture.gozar.closeRoute({
				home: fixture.home,
				handle: route.handle,
				mode: "remove",
			});
			assert.equal(closed.cleanup.state, "confirmed");
			const starts = await fixture.startCount(),
				replay = await fixture.start();
			assert.deepEqual(replay.handle, route.handle);
			assert.equal(replay.published, null);
			assert.equal(replay.cleanup.state, "confirmed");
			assert.equal(await fixture.startCount(), starts);
		} finally {
			await fixture.close();
		}
	});
	test(`${usage}: an unavailable owned-route inventory errors instead of reporting no routes`, {
		timeout: 60000,
	}, async () => {
		const fixture = await createPreparedFixture(undefined, { usage });
		const unavailable = join(fixture.root, "unavailable-home");
		await mkdir(unavailable, { mode: 0o000 });
		try {
			await assert.rejects(
				fixture.gozar.listRoutes({ home: unavailable, owner: fixture.owner }),
			);
		} finally {
			await chmod(unavailable, 0o700);
			await fixture.close();
		}
	});
}
