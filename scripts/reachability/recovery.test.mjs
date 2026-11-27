// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { chmod, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { requireDiskFloor } from "./disk-floor.mjs";
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
		await requireDiskFloor();
		const parent = join(homedir(), ".tmp", "ra");
		await mkdir(parent, { recursive: true, mode: 0o700 });
		const root = await mkdtemp(join(parent, "crash-"));
		const child = fork(
			new URL("./recovery-crash-child.mjs", import.meta.url),
			[root, usage],
			{ stdio: ["ignore", "pipe", "pipe", "ipc"] },
		);
		let gozar, descriptor, failure;
		try {
			const [message] = await Promise.race([
				once(child, "message"),
				once(child, "exit").then(() => {
					throw new Error("Crash fixture exited before allocation");
				}),
			]);
			assert.ok(["allocated-before-host-handle-write", "start-failed"].includes(message.stage), "Start outcome must remain publicly recoverable, never an expected refusal");
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
				identity: { ...descriptor.identity, bootId: randomUUID() },
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
			assert.ok(recovered[0].handle?.id, "Even a failed start must retain one closeable owned handle");
			if (message.stage === "start-failed") {
				assert.equal(recovered[0].published, null, "A failed start cannot remain published");
				assert.ok(["unconfirmed", "confirmed"].includes(recovered[0].cleanup.state), "A failed start must retain terminal or cleanup recovery state");
				if (recovered[0].cleanup.state === "unconfirmed") assert.ok(recovered[0].cleanup.nextAction, "Retained cleanup needs a public retry action");
			}
			const eventPath = join(descriptor.root, "providers", descriptor.request.providerId, "events.jsonl");
			const starts = async () => {
				let content = "";
				try { content = await readFile(eventPath, "utf8"); } catch (error) { if (error.code !== "ENOENT") throw error; }
				return content.split("\n").filter(Boolean).map(line => JSON.parse(line)).filter(event => event.event === "start").length;
			};
			const beforeReplay = await starts();
			const input = { ...descriptor.request, operationId: message.operationId };
			const replay = usage === "durable" ? await gozar.ensureRoute(input) : await gozar.expose(input);
			assert.deepEqual(replay.handle, recovered[0].handle, "Recovery replay must return the retained handle");
			assert.equal(await starts(), beforeReplay, "Recovery replay must never create a second provider start");
			const closed = await gozar.closeRoute({
				home: descriptor.home,
				handle: recovered[0].handle,
				mode: "remove",
			});
			assert.equal(closed.cleanup.state, "confirmed");
		} catch (error) {
			failure = error;
		} finally {
			if (child.exitCode === null && child.signalCode === null) {
				child.kill("SIGKILL");
				await once(child, "exit");
			}
			let clean = Boolean(gozar);
			try {
				if (gozar) {
					for (const route of (await gozar.listRoutes({ home: descriptor.home, owner: descriptor.owner })).routes) {
						const result = await gozar.closeRoute({ home: descriptor.home, handle: route.handle, mode: "remove" });
						clean &&= result.cleanup.state === "confirmed";
					}
				}
			} catch (error) {
				clean = false;
				failure = failure ? new AggregateError([failure, error], "Recovery assertion and public cleanup both failed") : error;
			}
			if (clean) await rm(root, { recursive: true, force: true });
			else failure ??= new Error(`Recovery cleanup remains unconfirmed; retained evidence at ${root}`);
			if (failure) throw failure;
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
