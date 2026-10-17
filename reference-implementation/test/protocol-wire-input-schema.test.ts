// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Unit coverage for `parseReferenceWireInputPayload`'s closed, type-specific
 * schema. This is the single pre-dispatch gate every wire input event passes
 * through before `cdp-adapter.ts` forwards it to the Remote Surface backend
 * or raw CDP (routes.ts:2497, cdp-adapter.ts:1423-1424). The security
 * re-check (rechk329-final-1001.md item 6) found the prior version accepted
 * nested objects/arrays in allowed fields and did not require fields or
 * validate action/type-specific values — a head probe passed
 * {type:"pointer",action:"pointermove",x:{nested:"x"},y:1} through unchanged.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { parseReferenceWireInputPayload } from "../server/streaming/protocol-wire.ts";

function assertRejected(payload: unknown): void {
	assert.throws(
		() => parseReferenceWireInputPayload(payload),
		(err: unknown) => {
			assert.ok(err instanceof Error);
			assert.equal((err as Error & { code?: string }).code, "invalid_input");
			return true;
		},
	);
}

test("rejects the exact nested-object head probe from the security re-check", () => {
	// {type:"pointer",action:"pointermove",x:{nested:"x"},y:1}
	assertRejected({
		action: "pointermove",
		type: "pointer",
		x: { nested: "x" },
		y: 1,
	});
});

test("rejects an array value in place of a declared numeric field", () => {
	assertRejected({ action: "pointermove", type: "pointer", x: [1, 2], y: 1 });
});

test("rejects an array value in place of a declared string field", () => {
	assertRejected({ action: ["pointerdown"], type: "pointer", x: 1, y: 1 });
});

test("rejects a nested-object value for a declared string field", () => {
	assertRejected({ text: { toString: () => "hi" }, type: "paste" });
});

test("accepts a well-formed pointer event with the full production field set", () => {
	const parsed = parseReferenceWireInputPayload({
		action: "wheel",
		buttons: 0,
		deltaX: 5,
		deltaY: -10,
		gestureBoundary: true,
		pointerType: "touch",
		source: "touch-gesture",
		type: "pointer",
		x: 100,
		y: 200,
	});
	assert.equal(parsed.action, "wheel");
	assert.equal(parsed.deltaX, 5);
});

test("rejects a pointer event missing a required field", () => {
	assertRejected({ action: "pointerdown", type: "pointer", y: 1 });
	assertRejected({ type: "pointer", x: 1, y: 1 });
});

test("rejects an action outside the type's closed enum", () => {
	assertRejected({ action: "pointerexplode", type: "pointer", x: 1, y: 1 });
	assertRejected({ action: "spin", type: "mouse", x: 0, y: 0 });
});

test("rejects a field not declared for the event's type", () => {
	assertRejected({
		action: "pointerdown",
		evalPayload: "1+1",
		type: "pointer",
		x: 1,
		y: 1,
	});
});

test("rejects an out-of-range numeric field", () => {
	assertRejected({
		action: "pointerdown",
		type: "pointer",
		x: 1_000_000,
		y: 1,
	});
	assertRejected({
		action: "keydown",
		key: "a",
		location: 99,
		type: "keyboard",
	});
});

test("rejects an oversized string field", () => {
	assertRejected({ text: "x".repeat(16_385), type: "paste" });
});

test("rejects a boolean field given a non-boolean value", () => {
	assertRejected({ height: 600, mobile: "yes", type: "viewport", width: 800 });
});

test("rejects an unknown event type", () => {
	assertRejected({ type: "detonate", x: 1, y: 1 });
});

test("accepts a well-formed viewport event and rejects one missing a required field", () => {
	const parsed = parseReferenceWireInputPayload({
		height: 844,
		mobile: true,
		type: "viewport",
		width: 390,
	});
	assert.equal(parsed.width, 390);
	assertRejected({ type: "viewport", width: 390 });
});
