// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// A JSON parser that hands every number lexeme to the caller instead of
// rounding it through a binary64 double. Everything else decodes exactly as
// JSON.parse does, including `__proto__` as an ordinary own key.

export type NumberHandler = (lexeme: string, depth: number) => unknown;

const NUMBER = /-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/y;
const MAX_DEPTH = 256;

class Cursor {
	index = 0;
	readonly text: string;
	readonly onNumber: NumberHandler;

	constructor(text: string, onNumber: NumberHandler) {
		this.text = text;
		this.onNumber = onNumber;
	}

	fail(message: string): never {
		throw new SyntaxError(`${message} at position ${this.index}`);
	}

	skipWhitespace(): void {
		while (this.index < this.text.length) {
			const code = this.text.charCodeAt(this.index);
			if (code !== 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) {
				return;
			}
			this.index += 1;
		}
	}

	expect(char: string): void {
		if (this.text[this.index] !== char) {
			this.fail(`Expected '${char}'`);
		}
		this.index += 1;
	}

	string(): string {
		const start = this.index;
		this.expect('"');
		while (this.index < this.text.length) {
			const char = this.text[this.index];
			if (char === '"') {
				this.index += 1;
				return JSON.parse(this.text.slice(start, this.index)) as string;
			}
			this.index += char === "\\" ? 2 : 1;
		}
		return this.fail("Unterminated string");
	}

	number(depth: number): unknown {
		NUMBER.lastIndex = this.index;
		const match = NUMBER.exec(this.text);
		if (!match) {
			this.fail("Invalid number");
		}
		this.index += match[0].length;
		return this.onNumber(match[0], depth);
	}

	literal(word: string, value: unknown): unknown {
		if (!this.text.startsWith(word, this.index)) {
			this.fail("Invalid literal");
		}
		this.index += word.length;
		return value;
	}

	array(depth: number): unknown[] {
		this.expect("[");
		const items: unknown[] = [];
		this.skipWhitespace();
		if (this.text[this.index] === "]") {
			this.index += 1;
			return items;
		}
		while (true) {
			items.push(this.value(depth + 1));
			this.skipWhitespace();
			if (this.text[this.index] === ",") {
				this.index += 1;
				continue;
			}
			this.expect("]");
			return items;
		}
	}

	object(depth: number): Record<string, unknown> {
		this.expect("{");
		const members: Record<string, unknown> = {};
		this.skipWhitespace();
		if (this.text[this.index] === "}") {
			this.index += 1;
			return members;
		}
		while (true) {
			this.skipWhitespace();
			const key = this.string();
			this.skipWhitespace();
			this.expect(":");
			Object.defineProperty(members, key, {
				configurable: true,
				enumerable: true,
				value: this.value(depth + 1),
				writable: true,
			});
			this.skipWhitespace();
			if (this.text[this.index] === ",") {
				this.index += 1;
				continue;
			}
			this.expect("}");
			return members;
		}
	}

	// Step over a nested object or array without decoding it. The depth lives in
	// a counter, so no nesting can exhaust the call stack.
	skipContainer(): unknown {
		const placeholder = this.text[this.index] === "[" ? [] : {};
		let depth = 0;
		while (this.index < this.text.length) {
			const char = this.text[this.index];
			if (char === '"') {
				this.string();
				continue;
			}
			this.index += 1;
			if (char === "{" || char === "[") {
				depth += 1;
			} else if (char === "}" || char === "]") {
				depth -= 1;
				if (depth === 0) {
					return placeholder;
				}
			}
		}
		return this.fail("Unterminated container");
	}

	topLevelObject(): Record<string, unknown> {
		this.skipWhitespace();
		this.expect("{");
		const members: Record<string, unknown> = {};
		this.skipWhitespace();
		if (this.text[this.index] === "}") {
			this.index += 1;
			return members;
		}
		while (true) {
			this.skipWhitespace();
			const key = this.string();
			this.skipWhitespace();
			this.expect(":");
			this.skipWhitespace();
			const first = this.text[this.index];
			Object.defineProperty(members, key, {
				configurable: true,
				enumerable: true,
				value:
					first === "{" || first === "[" ? this.skipContainer() : this.value(1),
				writable: true,
			});
			this.skipWhitespace();
			if (this.text[this.index] === ",") {
				this.index += 1;
				continue;
			}
			this.expect("}");
			return members;
		}
	}

	value(depth: number): unknown {
		if (depth > MAX_DEPTH) {
			this.fail("JSON is nested too deeply");
		}
		this.skipWhitespace();
		const char = this.text[this.index];
		if (char === "{") {
			return this.object(depth);
		}
		if (char === "[") {
			return this.array(depth);
		}
		if (char === '"') {
			return this.string();
		}
		if (char === "t") {
			return this.literal("true", true);
		}
		if (char === "f") {
			return this.literal("false", false);
		}
		if (char === "n") {
			return this.literal("null", null);
		}
		return this.number(depth);
	}
}

/**
 * Parse `text` as one JSON value. `onNumber` receives each number lexeme and
 * the depth of the container that holds it (1 for a member of the top-level
 * value, 0 for a bare top-level number).
 */
export function parseJsonWithNumbers(
	text: string,
	onNumber: NumberHandler,
): unknown {
	const cursor = new Cursor(text, onNumber);
	const result = cursor.value(0);
	cursor.skipWhitespace();
	if (cursor.index !== text.length) {
		cursor.fail("Unexpected trailing content");
	}
	return result;
}

/**
 * Parse a JSON object keeping each top-level number lexeme for the caller.
 * Nested objects and arrays are not decoded: they become empty placeholders of
 * the same kind, which is all a top-level comparison needs, and they cannot
 * exhaust the stack however deep they are.
 */
export function parseTopLevelWithNumbers(
	text: string,
	onNumber: NumberHandler,
): Record<string, unknown> {
	const cursor = new Cursor(text, onNumber);
	const result = cursor.topLevelObject();
	cursor.skipWhitespace();
	if (cursor.index !== text.length) {
		cursor.fail("Unexpected trailing content");
	}
	return result;
}
