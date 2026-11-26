// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
// The recheck loop when the page moves to a new route, or a new generation of
// the same route, while a check for the old one is still out.
import assert from "node:assert/strict";
import test from "node:test";
import {
	type CheckOutcome,
	createRecheckLoop,
	RETRY_AFTER_FAILURE_MS,
	type RecheckTarget,
} from "./recheck-loop";

function harness() {
	const timers: { callback: () => void; ms: number }[] = [];
	const pending: {
		target: RecheckTarget;
		settle: (outcome: CheckOutcome) => void;
	}[] = [];
	const gaveUp: string[] = [];
	const loop = createRecheckLoop({
		run: (target) => new Promise((settle) => pending.push({ target, settle })),
		giveUp: (id) => gaveUp.push(id),
		now: () => 0,
		setTimer: (callback, ms) => {
			const timer = { callback, ms };
			timers.push(timer);
			return timer;
		},
		clearTimer: (timer) => {
			const index = timers.indexOf(timer as (typeof timers)[number]);
			if (index >= 0) timers.splice(index, 1);
		},
	});
	const fireNext = () => {
		const timer = timers.shift();
		assert.ok(timer, "a check is scheduled");
		timer.callback();
		return timer;
	};
	const settle = async (outcome: CheckOutcome) => {
		const check = pending.shift();
		assert.ok(check, "a check is out");
		check.settle(outcome);
		await new Promise((resolve) => setImmediate(resolve));
		return check.target;
	};
	return { loop, timers, pending, gaveUp, fireNext, settle };
}

const route = (id: string, generation: number): RecheckTarget => ({
	id,
	generation,
	delay: 20_000,
	key: `${id}-${generation}`,
});

test("a route that replaces one whose check is out gets its own check when that check ends", async () => {
	const h = harness();
	h.loop.track(route("a", 1));
	h.fireNext();
	h.loop.track(route("b", 1));
	await h.settle({ ok: true });
	const next = h.fireNext();
	assert.equal(next.ms, 20_000, "the new route waits its own delay");
	assert.equal(h.pending[0]?.target.id, "b");
});

test("a failed check for an old generation does not count against the new one", async () => {
	const h = harness();
	h.loop.track(route("a", 1));
	h.fireNext();
	h.loop.track(route("a", 2));
	await h.settle({ ok: false, code: "verification_failed" });
	const next = h.fireNext();
	assert.notEqual(
		next.ms,
		RETRY_AFTER_FAILURE_MS,
		"the old failure is not retried against the new generation",
	);
	assert.equal(h.pending[0]?.target.generation, 2);
	await h.settle({ ok: false, code: "verification_failed" });
	assert.deepEqual(
		h.gaveUp,
		[],
		"one failure of the new generation is retried first",
	);
	assert.equal(h.timers[0]?.ms, RETRY_AFTER_FAILURE_MS);
});
